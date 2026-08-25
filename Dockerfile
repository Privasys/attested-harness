# Attested Harness app image (WS3). Stages:
#   1. fork-Go build of proxy/ (-tags ratls, mirrors confidential-ai's build)
#   2. node build of dsh at the vendor-dsh pin + the bundle plugins
#   3. runtime: node + built dsh + proxy + entrypoint; dsh LICENSE +
#      THIRD_PARTY_NOTICES retained (MIT compliance)
# Placeholder until WS1/WS2 land.
FROM scratch
LABEL org.privasys.status="skeleton"
