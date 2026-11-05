-- 2026-11-05: one shared price library (ex GST), fed by receipts, web finds in chat, and manual entries.
create table if not exists price_list (
  id bigserial primary key,
  item text not null, item_key text not null,
  supplier text not null default '', supplier_key text not null default '',
  unit text not null default '',
  unit_price numeric(12,2) not null,
  low numeric(12,2), high numeric(12,2),
  category text not null default '',
  source text not null default 'receipt',          -- receipt | web | quote | manual
  source_url text not null default '',
  last_seen date not null default current_date,
  times_seen int not null default 1,
  history jsonb not null default '[]'::jsonb,       -- last 20 [{d,p,s}]
  notes text not null default '',
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (supplier_key, item_key)
);
grant select on price_list to anon;
grant all on price_list to service_role;
grant usage, select on sequence price_list_id_seq to service_role;

create or replace function upsert_price(
  p_item text, p_supplier text, p_price numeric, p_unit text default '', p_category text default '',
  p_source text default 'receipt', p_url text default '', p_seen date default current_date, p_notes text default ''
) returns price_list language plpgsql as $$
declare
  ik text := lower(regexp_replace(coalesce(p_item,''),'[^a-zA-Z0-9]+','','g'));
  sk text := lower(regexp_replace(coalesce(p_supplier,''),'[^a-zA-Z0-9]+','','g'));
  r price_list;
begin
  if ik = '' or p_price is null or p_price <= 0 then return null; end if;
  insert into price_list(item,item_key,supplier,supplier_key,unit,unit_price,low,high,category,source,source_url,last_seen,history,notes)
  values (trim(p_item),ik,trim(coalesce(p_supplier,'')),sk,coalesce(p_unit,''),p_price,p_price,p_price,coalesce(p_category,''),p_source,coalesce(p_url,''),p_seen,
          jsonb_build_array(jsonb_build_object('d',p_seen,'p',p_price,'s',p_source)),coalesce(p_notes,''))
  on conflict (supplier_key,item_key) do update set
    times_seen = price_list.times_seen + 1,
    low  = least(coalesce(price_list.low, excluded.unit_price), excluded.unit_price),
    high = greatest(coalesce(price_list.high, excluded.unit_price), excluded.unit_price),
    history = case when jsonb_array_length(price_list.history) >= 20 then (price_list.history - 0) || excluded.history else price_list.history || excluded.history end,
    unit_price = case when excluded.last_seen >= price_list.last_seen then excluded.unit_price else price_list.unit_price end,
    source     = case when excluded.last_seen >= price_list.last_seen then excluded.source else price_list.source end,
    source_url = case when excluded.last_seen >= price_list.last_seen and excluded.source_url <> '' then excluded.source_url else price_list.source_url end,
    last_seen  = greatest(price_list.last_seen, excluded.last_seen),
    unit       = case when price_list.unit = '' then excluded.unit else price_list.unit end,
    category   = case when price_list.category = '' then excluded.category else price_list.category end,
    notes      = case when excluded.notes <> '' then excluded.notes else price_list.notes end,
    updated_at = now()
  returning * into r;
  return r;
end $$;

-- every receipt / expense line saved (by any route) feeds the library
create or replace function expense_to_price() returns trigger language plpgsql as $$
begin
  perform upsert_price(NEW.description, NEW.supplier, NEW.unit_price, '', NEW.category, 'receipt', '', coalesce(nullif(NEW.date::text,'')::date, current_date), '');
  return NEW;
exception when others then return NEW;   -- never block a receipt save
end $$;
drop trigger if exists expense_feeds_prices on expense_log;
create trigger expense_feeds_prices after insert on expense_log for each row execute function expense_to_price();

-- one-off backfill from existing receipts (run once; skipped if the library already has rows)
do $$ begin
  if not exists (select 1 from price_list) then
    perform upsert_price(description, supplier, unit_price, '', category, 'receipt', '', coalesce(nullif(date::text,'')::date, current_date), '')
    from expense_log where coalesce(description,'') <> '' and unit_price > 0 order by date asc;
  end if;
end $$;
