// Newsletter digest data source.
// Replace NEWSLETTER_ITEMS with real parsed items from your forwarding job.
// Each item:
//   id          unique string/number
//   headline    string — the item's title
//   summary     string — 1-2 sentence summary
//   url         string — link to the full piece
//   source      string — newsletter/publication name
//   topic       one of: "Tech" | "Business" | "Design" | "Productivity" (add more below if needed)
//   type        one of: "News" | "Deep-dive" | "Tools & Resources" | "Opinion"
//   readTime    number — estimated minutes to read
//
// If you add new topic or type values, also add them to TOPIC_ORDER / TYPE_ORDER
// in Newsletter Digest.dc.html so they get their own group section.

window.NEWSLETTER_ITEMS = [
  { id: 1, headline: 'Why platform fees keep climbing even as usage flattens', summary: 'A look at how take-rate creep is becoming the default growth lever once user growth slows, and what it signals about maturity.', source: 'The Margin', topic: 'Business', type: 'Deep-dive', readTime: 9, url: '#' },
  { id: 2, headline: 'Shipping a local-first sync engine in a weekend', summary: 'Walkthrough of CRDTs, conflict resolution, and why local-first is quietly becoming the default architecture for small tools.', source: 'Weekly Build', topic: 'Tech', type: 'Tools & Resources', readTime: 12, url: '#' },
  { id: 3, headline: 'The quiet return of dense, information-rich layouts', summary: 'Spacious minimalism is giving way to interfaces that respect the reader\u2019s time — more on screen, less scrolling.', source: 'Dense Notes', topic: 'Design', type: 'Opinion', readTime: 5, url: '#' },
  { id: 4, headline: 'Three inbox-zero systems, tested for a month each', summary: 'Comparing folder-based triage, label-based tagging, and a single unified queue across a month of real email volume.', source: 'North Star Letter', topic: 'Productivity', type: 'Deep-dive', readTime: 8, url: '#' },
  { id: 5, headline: 'Regulators open new inquiry into ad-tech data sharing', summary: 'A fast rundown of the filing, who it targets, and the likely timeline before anything changes in practice.', source: 'The Ledger', topic: 'Business', type: 'News', readTime: 4, url: '#' },
  { id: 6, headline: 'A minimal component library built entirely on native HTML', summary: 'No build step, no framework — just semantic elements and a handful of custom properties. The repo and the reasoning behind it.', source: 'Weekly Build', topic: 'Tech', type: 'Tools & Resources', readTime: 6, url: '#' },
  { id: 7, headline: 'What changed in the latest browser engine release', summary: 'CSS anchor positioning, view transitions, and a handful of smaller wins that quietly make layout code simpler.', source: 'Signal & Noise', topic: 'Tech', type: 'News', readTime: 5, url: '#' },
  { id: 8, headline: 'The case against another rebrand', summary: 'Why so many companies reach for a visual refresh when the actual problem is unclear positioning.', source: 'Dense Notes', topic: 'Design', type: 'Opinion', readTime: 7, url: '#' },
];
