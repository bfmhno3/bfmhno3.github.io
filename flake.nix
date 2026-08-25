{
  description = "Reproducible local development environment for the Jekyll site";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        ruby = pkgs.ruby_3_3;
        bundler = pkgs.bundler.overrideAttrs (_: {
          inherit ruby;
          version = "2.6.9";
          src = pkgs.fetchurl {
            url = "https://rubygems.org/downloads/bundler-2.6.9.gem";
            hash = "sha256-olZ1/70FWuEYZ2bMHhILTPYliOiKu1m5nFfiKxxVyes=";
          };
        });
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            ruby
            bundler
            pkgs.nodejs_24
            pkgs.git
            pkgs.gcc
            pkgs.gnumake
            pkgs.pkg-config
            pkgs.libyaml
            pkgs.openssl
            pkgs.zlib
            pkgs.libxml2
            pkgs.libxslt
            pkgs.libffi
            pkgs.curlMinimal.out
          ];
          shellHook = ''
            export BUNDLE_GEMFILE="$PWD/Gemfile"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.curlMinimal.out ]}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            echo "Ruby: $(ruby --version)"
            echo "Bundler: $(bundle --version)"
            echo "Node.js: $(node --version)"
            echo "npm: $(npm --version)"
            echo "开发环境已就绪。常用入口：bundle exec jekyll serve、npm run lint:markdown"
          '';
        };
      }
    );
}
