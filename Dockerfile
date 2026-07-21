FROM ruby:4.0-bookworm@sha256:0b28d5e7802f430cb78b20af30e196b40fc08c95839f50a0c1a7e84d667bc49e

ARG BUNDLER_VERSION=2.6.9

RUN gem install bundler --version "${BUNDLER_VERSION}" --no-document \
    && groupadd --gid 1000 jekyll \
    && useradd --uid 1000 --gid jekyll --create-home jekyll \
    && mkdir -p /usr/local/bundle /srv/jekyll \
    && chown -R jekyll:jekyll /usr/local/bundle /srv/jekyll

ENV BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_APP_CONFIG=/usr/local/bundle

USER jekyll
WORKDIR /srv/jekyll

EXPOSE 4000
