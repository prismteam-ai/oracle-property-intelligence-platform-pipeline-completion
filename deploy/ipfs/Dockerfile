# Oracle IPFS node — serves all ~20.9k Santa Clara per-property JSONs plus the
# dataset query-table Parquet, addressed by CID (CIDv0, matching the parquet's
# property_cid column). Content is `ipfs add`-ed at BUILD time so the daemon
# serves it immediately on boot. Gateway (8080) is public; API (5001) stays local.
#
# Build context is data/santa-clara/ (contains ipfs-properties/ and the parquet):
#   az acr build --registry <acr> --image oracle-ipfs:v2 \
#       --file deploy/ipfs/Dockerfile data/santa-clara
# Deploy:
#   az containerapp create -n oracle-ipfs -g <rg> --environment <env> \
#       --image <acr>.azurecr.io/oracle-ipfs:v2 \
#       --target-port 8080 --ingress external --min-replicas 1 --max-replicas 1 \
#       --cpu 1.0 --memory 2.0Gi
FROM ipfs/kubo:latest

ENV IPFS_PATH=/ipfsrepo
COPY ipfs-properties /import/ipfs-properties
COPY santa-clara-query-table.parquet /import/santa-clara-query-table.parquet

USER root
RUN mkdir -p /ipfsrepo && chown -R ipfs /ipfsrepo /import
USER ipfs

RUN ipfs init --profile server \
 && ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080 \
 && ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001 \
 && ipfs config --json Gateway.NoFetch true \
 && ipfs config --json Gateway.DeserializedResponses true \
 && ipfs add -rQ --cid-version=0 --pin=true /import/ipfs-properties \
 && ipfs add -Q --cid-version=0 --pin=true /import/santa-clara-query-table.parquet

EXPOSE 8080
