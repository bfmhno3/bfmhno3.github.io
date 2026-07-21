FROM ruby:3.3-bookworm@sha256:2405fae4df28e561be0ccc5b4c91b95204769fb659c1f41dc1defd2f02cfc2df

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
