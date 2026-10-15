# Generic Bank

A typed API that an AI agent calls to check balances, download statements and request
transfers at legacy banks that have no API. The system does the work by operating each bank's
website the way a person would, hands the work to a person when it cannot proceed safely, and
never moves money without a person's approval. A software factory learns each new bank.

Everything runs locally with docker compose and make.

```
make setup     # once, after git clone: tools, secrets, dependencies, image
make up        # the data box, the API, the Console, the crawler and two banks
make help      # every target
```

Then open the Console at http://localhost:8080 (sign in as `admin@generic-bank.local`; the
password is printed by `make console-password`).

The full documentation arrives with the system; this README grows with each milestone.
