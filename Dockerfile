# mailab: node app + python DSP/instrument bridges + instrument CLIs.
# Hardware access needs the host's USB/serial/video devices, e.g.
#   docker run --privileged --network host -v /dev:/dev -v mailab-data:/data \
#     -e MAILAB_TOKENS="me:<long-random-token>:rw" mailab
# HOST is 0.0.0.0 here, so the server refuses to start without MAILAB_TOKENS
# (MAILAB_ALLOW_OPEN=1 overrides that on a trusted network).
# (host networking: SCPI over LAN, and MCP/UI reachable on the host's port)
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		python3 python3-pip python3-numpy python3-serial python3-hid \
		libliquid1 \
		python3-soapysdr soapysdr-tools \
		soapysdr-module-hackrf soapysdr-module-bladerf soapysdr-module-rtlsdr \
		hackrf sigrok-cli ffmpeg v4l-utils uhubctl usbutils \
	&& rm -rf /var/lib/apt/lists/*

# python libraries that aren't packaged in Debian
RUN pip3 install --no-cache-dir --break-system-packages pymp305 findus

WORKDIR /app
COPY package.json yarn.lock ./
# --ignore-scripts: skip the husky `prepare` hook (no git in the image)
RUN yarn install --frozen-lockfile --ignore-scripts
COPY . .
# bundle the web UI (esbuild is a dev dependency), then drop dev dependencies
RUN yarn build && yarn install --production --frozen-lockfile --ignore-scripts && yarn cache clean

ENV HOST=0.0.0.0 \
	PORT=3000 \
	DATA_DIR=/data
VOLUME /data
EXPOSE 3000

CMD ["npx", "forever", "src"]
