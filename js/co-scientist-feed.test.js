import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCoScientistIntent,
  pickFeedContext,
  buildCoScientistReply,
} from "./co-scientist-chat.mjs";
import { normalizeFeedItem } from "./co-scientist-feed.mjs";
import { recordFeedback, profileFromFeedback } from "./co-scientist-feedback.mjs";

test("classifyCoScientistIntent detects literature and code", () => {
  assert.deepEqual(classifyCoScientistIntent("Find pubmed papers on KRAS"), ["literature"]);
  assert.ok(classifyCoScientistIntent("Write python analysis code").includes("code"));
});

test("pickFeedContext prioritizes pubmed for literature", () => {
  const items = [
    normalizeFeedItem({ id: "1", source: "alphafold", title: "A", summary: "", url: "" }),
    normalizeFeedItem({ id: "2", source: "pubmed", title: "B", summary: "", url: "" }),
  ];
  const picked = pickFeedContext(items, ["literature"], 2);
  assert.equal(picked[0].source, "pubmed");
});

test("buildCoScientistReply includes desk routing and citations", () => {
  const feed = {
    items: [
      normalizeFeedItem({
        id: "p1",
        source: "pubmed",
        title: "Test paper",
        summary: "x",
        url: "https://pubmed.ncbi.nlm.nih.gov/1/",
      }),
    ],
  };
  const reply = buildCoScientistReply({ message: "Summarize latest KRAS papers", feed });
  assert.ok(reply.markdown.includes("pubmed"));
  assert.ok(reply.intents.includes("summarize"));
});

test("feedback profile becomes concise after downs", () => {
  let state = recordFeedback(undefined, { rating: "down", intents: ["summarize"] });
  state = recordFeedback(state, { rating: "down", intents: ["summarize"] });
  state = recordFeedback(state, { rating: "down", intents: ["summarize"] });
  const profile = profileFromFeedback(state);
  assert.equal(profile.verbosity, "concise");
});
