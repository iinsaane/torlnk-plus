FROM golang:1.27-alpine3.23@sha256:0908ac9b9319e09d7c238aabe914e0395c51d63c4e3d0ae8c554fda9158a5769 AS build
RUN apk add --no-cache git
WORKDIR /src
RUN git init && git remote add origin https://github.com/Windscribe/wstunnel.git && git fetch --depth 1 origin a7408ae39552108307b19839cfd70f1f5a39c241 && git checkout FETCH_HEAD
COPY containers/wstunnel-go-deps.patch /tmp/wstunnel-go-deps.patch
RUN git apply /tmp/wstunnel-go-deps.patch \
    && go mod download \
    && go mod verify \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/wstunnel .

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN adduser -D -u 10001 wstunnel
COPY --from=build /out/wstunnel /usr/local/bin/wstunnel
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/wstunnel"]
