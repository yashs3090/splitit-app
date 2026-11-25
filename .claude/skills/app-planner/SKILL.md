---
name: app-planner
description: Research and plan an app idea or feature using four perspectives — a Product Manager who asks critical questions, a Researcher who studies competitors and prior art, a User who reacts as the target customer, and an Engineer who brainstorms implementation. Use when the user wants to research, plan, scope, validate, or pressure-test an app idea, feature, pricing tier, or MVP.
---

# App Planner

Run a structured planning session on an app idea (or one feature of it) through four personas. Each persona has a distinct job. Don't let them blur into one generic voice. They should disagree with each other where that's warranted.

## Inputs

- The idea or feature to plan. If the user gave none, use the project context in `CLAUDE.md` and ask which part to focus on.
- Optional: a focus such as `mvp`, `pricing`, `security`, `competitors`, or `architecture`. When given, go deeper on that area and keep the other sections brief.

## Process

Work through the phases in order. Write the final output to `docs/plans/<kebab-topic>-<YYYY-MM-DD>.md` (create the folder if needed), then summarize the key decisions and open questions in chat.

### Phase 0: Frame the idea (PM)
Restate the idea in two or three sentences: who it's for, the problem, and the proposed solution. List the assumptions the idea depends on. If something essential is unclear and can't be reasonably assumed, ask the user up to 3 questions before continuing. Otherwise state your assumptions and proceed.

### Phase 1: Researcher, the market and prior art
Use WebSearch/WebFetch to find real, current information. Cite sources with links. Never invent products, prices, or statistics; if you can't verify something, label it "unverified".
- **Direct competitors**: what they do, pricing (free vs. paid), platforms, and notable strengths and weaknesses. Mine app-store reviews, Reddit, and HN for complaints.
- **Adjacent or indirect alternatives**, including spreadsheets, bank-native tools, and "do nothing".
- **How others built it**: public engineering blogs, open-source projects, APIs and SDKs they use.
- **Gaps and opportunities**: what's underserved, and where the user's idea genuinely differs from what exists.
- **Regulatory or platform constraints** that apply to this domain.

Output a comparison table plus a short "what this means for us" paragraph.

### Phase 2: User, the voice of the customer
Create 2–3 concrete personas who would plausibly use the product. Make them distinct, e.g. a budget-conscious student, a busy professional, a privacy-skeptic. For each:
- Background and current workflow (what they do today without the app)
- Jobs-to-be-done and top pain points
- Walk through first use in first person ("I open the app and...") and note where they get confused, delighted, or drop off
- What would make them pay, and what would make them churn or never sign up (trust, effort, price)
- Honest objections ("Why would I upload my bank statement to a random app?")

### Phase 3: Product Manager, critical questions
Challenge the idea; don't cheerlead. Cover:
- **Problem validity**: is this a real, frequent, painful problem? What's the evidence?
- **Differentiation**: why would someone choose this over the competitors in Phase 1?
- **Scope**: what is the smallest MVP that tests the riskiest assumption? List what's explicitly *out* of scope for v1.
- **Monetization**: free vs. paid tier boundary, willingness to pay, and unit-cost concerns (e.g. per-connection API fees vs. subscription price).
- **Success metrics**: activation, retention, and conversion metrics with rough targets.
- **Risks**: rank by likelihood × impact across trust, legal, technical, market, and cost.
- **Kill criteria**: what result would mean we should stop or pivot?

End with the top 5 open questions that most need answers, ordered by importance.

### Phase 4: Engineer, implementation brainstorm
Propose a practical design sized for the team (assume a solo developer or small team unless told otherwise).
- **Architecture options**: 2–3 approaches, each with tradeoffs (cost, complexity, time-to-MVP, scalability). Recommend one.
- **Tech stack** for frontend, backend, database, auth, and hosting, with reasons.
- **Core pipelines**: walk the data flow end to end (ingestion → parsing → normalization → categorization → storage → reports).
- **Hard problems**: name the technically risky parts and how to de-risk them, including spikes or prototypes worth building first.
- **Security and privacy** design: encryption at rest and in transit, data retention and deletion, least-privilege access, secrets handling, and compliance considerations.
- **Third-party services** with approximate costs. Verify current pricing via the Researcher's sources where possible.
- **Data model sketch**: key entities and relationships.
- **Milestone plan**: an ordered build plan from MVP to v1 to v2, with rough effort sizing (S/M/L).

### Phase 5: Roundtable and synthesis
Have the personas react to each other briefly. For example, the User pushes back on the Engineer's onboarding, or the PM cuts scope the Engineer proposed. Then produce:
- **Recommended MVP** (one paragraph plus a bullet list of features)
- **Key decisions made**, with rationale
- **Open questions and next validation steps**, each with a concrete action (e.g. "interview 5 students", "prototype a PDF parser against 3 banks' statements")
- **Risks to watch**

## Style rules
- Be specific and concrete. Use real product names, real APIs, real numbers with sources.
- Prefer tables for comparisons and bullets for lists. Keep prose tight.
- Disagreement between personas is useful. Surface tensions rather than smoothing them over.
- Clearly separate verified facts (with links) from assumptions and opinions.
