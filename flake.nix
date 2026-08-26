{
  description = "Reproducible Astro + Firefly development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forEachSystem (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.pnpm ];
            shellHook = ''
              export PNPM_HOME="$PWD/.pnpm"
              export PATH="$PNPM_HOME:$PATH"
              echo "Node.js: $(node --version)"
              echo "pnpm: $(pnpm --version)"
              echo "Run: pnpm install, pnpm dev, pnpm check, pnpm build"
            '';
          };
        });
    };
}
