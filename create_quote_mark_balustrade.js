// ─────────────────────────────────────────────────────────────────────────────
// DRAFT QUOTE — Stainless Steel Wire Balustrade 6m — Mark Shippen
// Run this in the browser console while on matierehub2.netlify.app
// Requires: Xero connected (green ⚡ button visible in header)
// ─────────────────────────────────────────────────────────────────────────────

const quotePayload = {
  Quotes: [{
    Contact: {
      ContactID: "d79444a2-34cf-40ee-bf53-fc2fed4bad89"   // Mark Shippen
    },
    Date:       "2026-05-28",
    ExpiryDate: "2026-06-25",   // 28 days validity
    Status:     "DRAFT",
    Title:      "Stainless Steel Wire Balustrade — 6m",
    Summary:    "Supply and installation of a 6-metre stainless steel wire rope balustrade system including SS316 posts, wire runs, hardwood handrail and all associated hardware. Quote valid for 28 days from date of issue.",

    LineItems: [

      {
        Description: [
          "Materials — SS316 Wire Balustrade System (6 lineal metres)",
          "",
          "• 5 × SS316 square hollow section posts 50×50×3mm with welded base flanges",
          "• 10 runs × 3.2mm SS316 marine-grade wire rope (approx. 7m per run)",
          "• SS316 swaged jaw-end fittings and jaw/jaw turnbuckles with locking nuts (20 sets)",
          "• 90×42mm clear-grade hardwood handrail 6.5m (finger-jointed, primed, ready to paint)",
          "• Post cap plates (stainless), wall-end anchor plates and cover escutcheons",
          "• Stainless A4 fixings, chemical anchors, construction adhesive, paintable gap sealant"
        ].join("\n"),
        Quantity:    1,
        UnitAmount:  2300.00,
        AccountCode: "200",
        TaxType:     "OUTPUT"
      },

      {
        Description: [
          "Labour — Fabrication, Installation & Commissioning (approx. 18 hrs)",
          "",
          "1. Set out and mark post positions in accordance with site dimensions and balustrade drawing",
          "2. Drill substrate and chemically anchor base flanges (concrete anchor bolts where required)",
          "3. Plumb, align and fix posts — check for level and true vertical on all axes",
          "4. Thread all wire runs through posts, tension evenly and lock off with swaged fittings",
          "5. Adjust turnbuckles to achieve uniform tension across all runs; verify 100mm max deflection compliance",
          "6. Cut, shape and fix hardwood handrail to posts with countersunk stainless screws",
          "7. Fill and seal all penetrations, clean down all stainless surfaces",
          "8. Final inspection, tension re-check and client handover"
        ].join("\n"),
        Quantity:    18,
        UnitAmount:  100.00,
        AccountCode: "200",
        TaxType:     "OUTPUT"
      }

    ]
  }]
};

// ── Submit to Xero via Netlify function ──────────────────────────────────────
console.log("Creating draft quote in Xero…");

xeroApiCall("Quotes", "POST", quotePayload)
  .then(response => {
    if (response.Quotes && response.Quotes[0]) {
      const q = response.Quotes[0];
      console.log("✓ Quote created:", q.QuoteNumber);
      console.log("  Total (ex GST): $" + q.SubTotal);
      console.log("  GST:            $" + q.TotalTax);
      console.log("  Total (inc GST):$" + q.Total);
      console.log("  Status:", q.Status);
      console.log("  Expiry:", q.ExpiryDateString || q.ExpiryDate);
      alert(
        "✓ Draft quote created in Xero!\n\n" +
        "Quote: " + q.QuoteNumber + "\n" +
        "Client: Mark Shippen\n" +
        "Total: $" + q.SubTotal + " ex GST  ($" + q.Total + " inc GST)\n" +
        "Valid until: 25 June 2026\n\n" +
        "Open Xero to review, edit and send."
      );
    } else {
      console.error("Unexpected response:", JSON.stringify(response, null, 2));
      alert("Error — check console for details.");
    }
  })
  .catch(err => {
    console.error("Failed:", err);
    alert("Error: " + err.message);
  });
