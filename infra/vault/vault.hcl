# Local Vault: file storage on a volume, so trusted-workstation cookies survive a restart.
# Reachable only on box B's networks; TLS is a plan 2 concern.
storage "file" {
  path = "/vault/file"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}
disable_mlock = true
ui            = false
