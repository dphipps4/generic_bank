# M7: The factory

The factory teaches the crawler a bank it has not seen, for the three things the product does:
check a balance, prepare a transfer up to the bank's review page, and download statements where
the bank offers them. Navigation is there to reach those goals; reasoning is there to guide the
navigation.

Two roles. The **Scout** navigates: it opens the bank, signs in, clicks and types, one simple step
at a time, and reports each page to the Supervisor. The **Supervisor** looks at the evidence for
every step (the frame: the masked screenshot and the visible page as JSON), reasons about where
the Scout is and what to do next toward the goal, and tells it. Only the Supervisor recommends.
Its recommendation is the bank's profile (its words, its screens, its refusals), and every claim in
it cites the frames that show it and says whether it was **seen** on those frames or is a
**guess**. A person approves or rejects it with the frames in front of them. A guess is never
approved by default.

The bank's own behavior is the judge: the profile is run against the bank with each hazard
forced, and the result must be the one the outcome table expects. Without an API key the factory
replays a recorded run (mock mode), so the whole path runs for free.

| # | Pull request | What it adds | What proves it |
|---|---|---|---|
| 1 | **This sheet, and the plan** | The Scout and the Supervisor as above, in §7 and Appendix M; a recommendation and its basis | the plan and this sheet agree |
| 2 | **The model gateway, caps and mock mode** | One route to the model, metered; the caps in code; recorded responses replayed when there is no key | a run at a cap is refused before the request; mock mode replays a recording byte for byte |
| 3 | **The Scout** | Open an allowed host, look (a frame), click and type by control reference, type a credential by name, enter a person's code; a frame for every page | the Scout cannot reach a host off the allowlist, type a secret, or run page script |
| 4 | **The Supervisor** | After every Scout step: where we are, the next step toward the goal, or stop, citing the frame | on bank 1, guided by the Supervisor, the Scout reaches the balance, the transfer review page and the statements list |
| 4b | **On pi, any provider** | The Scout and the Supervisor run as pi sessions; each role's provider, model and effort from config; an OpenAI route through the gateway, metered like Anthropic's | the same mock run passes on the Anthropic defaults and with OpenAI configured; an unpriced model is refused |
| 5 | **The recommendation** | The profile drafted from the frames, each claim citing frames and marked seen or guess; the Console's review card with the Frames button, Approve and Reject | a claim with no frame is refused; a guess shows as a guess |
| 6 | **The hazard check** | The approved profile run against the bank with each hazard forced; the expected results from the outcome table; candidate, probation, promoted | the profile passes every hazard before probation; two clean runs promote it |
| 7 | **Bank 2, end to end** | `make factory` onboards bank 2 in mock mode from a recorded run; the run in the Console | a fresh clone runs it with no API key and bank 2 appears in `GET /banks` |
