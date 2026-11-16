FROM gliderlabs/herokuish:latest

COPY . /app

WORKDIR /app

RUN /bin/herokuish buildpack build

ENV PORT 3000
# listen on all interfaces inside the container
ENV HOST 0.0.0.0

EXPOSE 3000
