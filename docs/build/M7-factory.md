# M7: The factory

The factory teaches the crawler a bank it has not seen, for the three things the product does:
check a balance, prepare a transfer up to the bank's review page, and download statements where
the bank offers them. Navigation serves those goals, and reasoning guides the navigation.

Two roles. The **Scout** navigates: it opens the bank, signs in, clicks and types, one simple step
at a time, and reports each page to the Supervisor. The **Supervisor** looks at the evidence for
every step (the frame: the masked screenshot and the visible page as JSON), reasons about where
the Scout is and what to do next toward the goal, and tells it. Only the Supervisor recommends.
Its recommendation is the bank's profile (its words, its screens, its refusals), and every claim in
it cites the frames that show it and says whether it was **seen** on those frames or is a
**guess**. A person approves or rejects it with the frames in front of them. A guess is never
approved by default.

The bank's own behavior is the judge: the profile runs against the bank with each hazard forced,
and each result must be the one the outcome table expects. Without an API key the factory
replays a recorded run (mock mode), so the whole path costs nothing.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **This sheet, and the plan** | The Scout and the Supervisor as above, in §7; a recommendation and its basis | the plan and this sheet agree |
| 2 | **The model gateway, caps and mock mode** | One route to the model, metered; the caps in code; recorded responses replayed when there is no key | a run at a cap is refused before the request; mock mode replays a recording exactly, whatever the model is called (`apps/factory/test/gateway.test.ts`) |
| 3 | **The Scout** | Open an allowed host, look (a frame), click and type by control reference, type a credential by name, enter a person's code; a frame for every page | the Scout signs in and reads the bank in the repair run (`tests/browser/repair.test.ts`); its limits have no test of their own |
| 4 | **The Supervisor** | After every Scout step: where we are, the next step toward the goal, or stop, citing the frame | the Supervisor answers only in its fixed form, citing frames, and stops the run when it should (`apps/factory/test/supervisor.test.ts`); on bank 1, guided by it, the Scout reaches the balance in the repair run (`tests/browser/repair.test.ts`) |
| 4b | **On pi, any provider** | The Scout and the Supervisor run as pi sessions; each role's provider, model and effort from config; an OpenAI route through the gateway, metered like Anthropic's | a role's turn runs as a pi session through the real gateway (`apps/factory/test/agent.test.ts`); the OpenAI route has no test, and an unpriced model counts as free |
| 5 | **The recommendation** | The profile drafted from the frames, each claim citing frames and marked seen or guess; the Console's review card with the Frames button, Approve and Reject | a claim with no frame is refused; a guess shows as a guess |
| 6 | **The hazard check** | The approved profile run against the bank with each hazard forced; the expected results from the outcome table; candidate, probation, promoted | the profile passes every hazard before probation; two clean runs promote it |
| 7 | **Bank 2, end to end** (Part 2) | `just factory` onboards bank 2 in mock mode from a recorded run; the run in the Console | a fresh clone runs it with no API key and bank 2 appears in `GET /banks` |
