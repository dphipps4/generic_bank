# Appendix B: results

Every task answers with one result: a status, and for anything but success, a code. The status sets the HTTP status ([`httpStatus`](../packages/contracts/src/index.ts)), and the codes are the contract's own ([`CODES`](../packages/contracts/src/index.ts)).

## Statuses

| Status | HTTP | Means | The caller |
|---|---|---|---|
| `running` | 202 | The run is working | Asks again; `Retry-After` says when |
| `needs_human` | 202 | Waiting for a person: a code, or a transfer's approval | Asks again |
| `succeeded` | 200 | Done, with its data | Reads the data |
| `handed_off` | 200 | A person finished it by hand | Reads the result |
| `business_outcome` | 422 | The bank's own answer | Tells the member; retrying won't change it |
| `escalated` | 409 | Stopped; a person has it in the Console | Asks again later: 202 after Resume, 200 after Finish by hand, 410 after Cancel |
| `expired`, `cancelled` | 410 | No one answered in time, or it was cancelled | Starts a new task if still wanted |
| `failed` | 503 | A failure a retry may fix | Retries after `Retry-After` |
| `failed` | 502 | A failure a retry won't fix | Doesn't retry |

## Codes

| Status | Code | Means |
|---|---|---|
| business_outcome | `no_such_member` | The bank has no member with that number |
| | `member_closed` | The member's membership is closed |
| | `no_such_account` | The member has no account matching that reference |
| | `insufficient_funds` | Not enough available balance |
| | `permission_denied` | The bank doesn't allow this for that account |
| | `account_restricted` | The account is restricted; the member should visit a branch |
| | `limit_exceeded` | Over the bank's daily limit |
| | `invalid_amount` | The bank didn't accept that amount |
| | `approval_rejected` | A person didn't approve the transfer |
| needs_human | `awaiting_staff_code` | Waiting for a person to enter the bank's sign-in code |
| | `awaiting_approval` | Waiting for a person to approve the transfer |
| handed_off | `taken_over` | A person finished the task by hand |
| escalated | `unknown_screen` | The bank showed a page the crawler doesn't know |
| | `stuck` | The same page three times, or something unexpected |
| | `ambiguous_outcome` | Unclear whether a transfer happened; a person checks before anything is repeated |
| | `guard_tripped` | A safety check refused an action; the bank is frozen |
| failed | `app_error` | The bank's system reported an error |
| | `unavailable` | The bank's system is unavailable (retryable) |
| | `record_in_use` | The member's record is in use at the bank (retryable) |
| | `operator_locked` | The bank locked the system's staff account |
| | `bad_credentials` | The bank didn't accept the staff credentials |
| | `step_timeout` | A page never became ready |
| | `no_driver` | No crawler serves that task at that bank |
| expired | `expired` | Nobody answered in time |
| cancelled | `cancelled` | The task was cancelled |

## Bank 1's words for each outcome

Bank 1's table maps its own words to these codes, each citing the frame it was read from: see [the evidence walkthrough](evidence/bank-1/README.md#the-banks-answers).
