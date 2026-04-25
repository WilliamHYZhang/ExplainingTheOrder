# Explaining the Order

A browser demo for visualizing why one web result ranks above another with a
fixed Wikipedia corpus and offline PageRank.

## What is here

- A query box that searches a frozen 5,000-page English Wikipedia sample
- Real Wikipedia titles, URLs, summaries, and internal article links
- Offline full-corpus PageRank with sampled replay checkpoints
- Local text retrieval blended with normalized global PageRank
- A staged visualization: equal visible nodes, authority flowing through links,
  checkpoint replay, and final ranked order
- A ranked result list, graph view, and selected-page explanation inspector

## Getting started

```bash
npm install
npm run generate:corpus
npm run dev
```

Then open the local Vite URL printed in the terminal.

## Build

```bash
npm run build
```

## Tests

```bash
npm run test
```

## Corpus

The generated artifact lives at `src/data/wikiCorpus.json`. It is produced from
the frozen `enwiki-latest-pages-articles1.xml-p1p41242.bz2` article dump and is
safe for a static deployment. The browser app does not call Wikipedia at
runtime.

## Notes

- This is a static demo, not a live web crawler.
- It is a simplified PageRank-style search model, not a claim to reproduce
  modern Google Search.
