# for-sale-by-owner

A guided assistant that lets a homeowner sell their house without hiring a real estate agent.

An Apple OS application (web version a possible alternative) that prices the home, writes the listing, generates the MLS record, and points the seller toward the local help they still need — keeping the commission in the seller's pocket.

Built by Matt LoPolito, Kaitlyn Cohen, and Chloe Scocimara for the AI Builder Space Proseminar.

## The user

Any American homeowner motivated to sell and reluctant to surrender several percent of the sale price to do it.

## Scope

**The core of this sprint is pricing advice.** Getting the number right is the hardest first step for a seller and the closest thing realtors have to an irreplaceable skill. If only one capability works well by the end, this is the one.

### Must-haves

- **Pricing advice** — a defensible recommended listing price for a given property
- Listing copy written from the property's details
- MLS-format listing generation
- Referrals to local photographers and contract attorneys

### Stretch

Depending on how far we get: negotiation support, publication to the MLS, calendaring of showings. These are not committed work.

### Deliberately out of scope

Offer paperwork. Payment facilitation. Closing and contracting.

## Success criteria

The test is a real house. We run the app's pricing advice on a home the team has direct access to and compare the result against the owners' own independent view, built from their research and public estimates such as Zillow's. **A recommendation within $50,000 of their best guess counts the sprint a success.** If it misses, we will know exactly where the model is failing.

## Open questions

Two questions are unresolved, and both sit under the parts of the product we care most about. Neither should be assumed solved — if a plan depends on one, say so explicitly.

1. **MLS publication.** We do not know whether a non-agent application can publish to the MLS directly, what credentials or partnerships that would require, or whether the realistic path is generating a listing the seller hands to a flat-fee service. This is why publication sits outside the must-haves.
2. **Comparable-sales data.** Reliable comps are what make a price recommendation defensible, and we have not yet identified a source we can access and afford.

## Prior art

2026 brought a wave of AI-native competitors aimed at unrepresented sellers — Ridley, For Sale By AI, a flat-fee AI platform in Arizona — plus AI guidance layered onto Zillow and Compass. Ridley in particular covers substantially this territory. We are building this anyway, deliberately: the value is in building the thing ourselves, not in claiming untouched ground.

## License

MIT — see [LICENSE](LICENSE).
