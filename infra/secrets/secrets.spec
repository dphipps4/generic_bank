# Every secret the system uses: FILE KEY HOW
#   HOW = hex      48 random hex characters
#         password 20 random letters and digits (something a person types)
#         blank    left empty on purpose
local   POSTGRES_PASSWORD        hex
local   BANK_DB_PASSWORD         hex
local   API_KEY                  hex
local   CONSOLE_SESSION_SECRET   hex
local   CONSOLE_COOKIE_SECRET    hex
local   CONSOLE_ADMIN_PASSWORD   password
local   MINIO_ROOT_USER          hex
local   MINIO_ROOT_PASSWORD      hex
local   MEMORY_TOKEN_RUNNER      hex
local   MEMORY_TOKEN_CURATOR     hex
local   MEMORY_TOKEN_SYSTEM      hex
local   MEMORY_SIGNING_KEY       hex
local   HAZARD_HMAC_KEY          hex
local   BANK_ADMIN_TOKEN         hex
factory ANTHROPIC_API_KEY        blank
local   MEMORY_TOKEN_FACTORY     hex
factory FACTORY_GATEWAY_TOKEN    hex
ops     VAULT_ROOT_TOKEN         blank
ops     VAULT_UNSEAL_KEY         blank
