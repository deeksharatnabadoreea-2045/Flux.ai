import { routeBrief } from "./desks.js";

const INTENT_PATTERNS = [
  { intent: "literature", re: /\b(pubmed|paper|literature|cite|citation|article|journal|review)\b/i },
  { intent: "summarize", re: /\b(summarize|summary|tl;dr|abstract|digest)\b/i },
  { intent: "code", re: /\b(code|script|python|r|notebook|pipeline|analysis code)\b/i },
  { intent: "debug", re: /\b(debug|error|traceback|fix|broken|failing)\b/i },
  { intent: "methods", re: /\b(methods?|protocol|sop|materials? and methods|experimental design)\b/i },
  { intent: "hypothesis", re: /\b(hypothesis|hypotheses|predict|mechanism|if .+ then|model)\b/i },
  { intent: "structure", re: /\b(alphafold|structure|pdb|uniprot|protein|binding site)\b/i },
];

export function classifyCoScientistIntent(message) {
  const text = String(message ?? "").trim();
  const hits = INTENT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.intent);
  if (!hits.length) return ["general"];
  return [...new Set(hits)];
}

export function pickFeedContext(items, intents, limit = 5) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const sourcePriority = {
    literature: ["pubmed"],
    summarize: ["pubmed"],
    methods: ["pubmed", "uniprot"],
    hypothesis: ["pubmed", "uniprot", "alphafold"],
    structure: ["alphafold", "uniprot"],
    code: ["uniprot", "alphafold"],
    debug: ["uniprot"],
    general: ["pubmed", "uniprot", "alphafold"],
  };

  const order = new Set();
  for (const intent of intents) {
    for (const src of sourcePriority[intent] ?? []) order.add(src);
  }
  if (!order.size) ["pubmed", "uniprot", "alphafold"].forEach((s) => order.add(s));

  const picked = [];
  for (const src of order) {
    for (const item of list) {
      if (item.source !== src) continue;
      if (picked.some((p) => p.id === item.id)) continue;
      picked.push(item);
      if (picked.length >= limit) return picked;
    }
  }
  return picked.slice(0, limit);
}

function citationBlock(context) {
  if (!context.length) return "_No live feed hits yet — run with `npm run dev` for PubMed/UniProt/AlphaFold pulls._";
  return context
    .map((item, i) => `${i + 1}. **${item.title}** (${item.source}) — ${item.url}`)
    .join("\n");
}

function section(title, body) {
  return `### ${title}\n${body.trim()}\n`;
}

export function applyFeedbackProfile(profile = {}) {
  const verbosity = profile.verbosity ?? "balanced";
  const tone = profile.tone ?? "direct";
  return { verbosity, tone };
}

export function buildCoScientistReply({ message, feed, feedbackProfile = {} }) {
  const intents = classifyCoScientistIntent(message);
  const deskId = routeBrief(message);
  const context = pickFeedContext(feed?.items ?? [], intents);
  const { verbosity } = applyFeedbackProfile(feedbackProfile);

  const lead =
    intents.includes("general") && intents.length === 1
      ? "I'm your **AI Co-Scientist** — I'll handle repetitive lab work so you keep judgment and direction."
      : `Routing this as **${intents.join(" + ")}** work (desk hint: \`${deskId}\`).`;

  const blocks = [lead, ""];

  if (intents.includes("literature") || intents.includes("summarize") || intents.includes("general")) {
    blocks.push(
      section(
        "Literature & summaries",
        `${verbosity === "concise" ? "Top feed picks:" : "Pulled from the live PubMed stream:"}\n${citationBlock(
          context.filter((c) => c.source === "pubmed").length
            ? context.filter((c) => c.source === "pubmed")
            : context,
        )}\n\n_Draft abstract-style summary next once you pin a PMID._`,
      ),
    );
  }

  if (intents.includes("structure") || intents.includes("hypothesis")) {
    const struct = context.filter((c) => c.source === "alphafold" || c.source === "uniprot");
    blocks.push(
      section(
        "Structures & targets",
        `${citationBlock(struct.length ? struct : context)}\n\n_Hypothesis stub:_ perturbation at the highlighted target should shift the readout you care about — specify assay + contrast.`,
      ),
    );
  }

  if (intents.includes("code") || intents.includes("debug")) {
    blocks.push(
      section(
        "Analysis code",
        "```python\n# Starter analysis scaffold (edit assay columns)\nimport pandas as pd\n\n df = pd.read_csv('your_counts.csv')\n# TODO: normalize · test · visualize\nprint(df.head())\n```\n\n_Paste your traceback or notebook cell for a debug pass._",
      ),
    );
  }

  if (intents.includes("methods")) {
    blocks.push(
      section(
        "Methods draft",
        "1. **Design** — state null hypothesis, primary endpoint, stopping rule.\n2. **Materials** — cell line / cohort IDs, reagents with RRID or catalog #.\n3. **Procedure** — numbered steps with units and controls.\n4. **Analysis** — pre-specified test, multiplicity correction, code archive.",
      ),
    );
  }

  if (intents.includes("hypothesis")) {
    blocks.push(
      section(
        "Hypotheses",
        "- **H1:** Mechanistic link between target and phenotype under defined perturbation.\n- **H2:** Alternative pathway confound (batch, sex, comorbidity).\n- **Kill criterion:** pre-register falsifying observation.",
      ),
    );
  }

  blocks.push(
    section(
      "Your call",
      "Tell me what to accept, return, or kill — I'll iterate. Thumbs on the reply train the co-pilot to be shorter or deeper over time.",
    ),
  );

  return {
    intents,
    deskId,
    contextIds: context.map((c) => c.id),
    markdown: blocks.join("\n"),
  };
}
