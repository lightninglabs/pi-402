{
  description = "rpi-402: an rpi provider plugin that pays for inference over L402 with a Wavelength wallet";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # The rpi host. It must be the revision Cargo.toml pins the plugin SDK
    # to; the rpi-revision check fails when the two drift apart.
    rpi-src = {
      url = "github:bigfish1913/pi-rust/d3e388d169bacf4351be2aefd76ba8d1944ded6f";
      flake = false;
    };
  };

  outputs =
    { self, nixpkgs, rpi-src }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          libExt = pkgs.stdenv.hostPlatform.extensions.sharedLibrary;

          # The plugin. Its library lands in lib/rpi/extensions, the
          # directory to pass to rpi's --extensions-dir.
          rpi-402 = pkgs.rustPlatform.buildRustPackage {
            pname = "rpi-402";
            version = "0.1.0";
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./src
                ./tests
              ];
            };
            cargoLock = {
              lockFile = ./Cargo.lock;
              allowBuiltinFetchGit = true;
            };
            postInstall = ''
              mkdir -p $out/lib/rpi/extensions
              mv $out/lib/librpi_402${libExt} $out/lib/rpi/extensions/
            '';
            meta = {
              description = "rpi provider plugin that pays for inference over L402";
              license = lib.licenses.mit;
            };
          };

          # The rpi host, built from the same revision as the plugin SDK.
          rpi = pkgs.rustPlatform.buildRustPackage {
            pname = "rpi";
            version = "0.25.0";
            src = rpi-src;
            cargoLock = {
              lockFile = "${rpi-src}/Cargo.lock";
              allowBuiltinFetchGit = true;
            };
            cargoBuildFlags = [
              "-p"
              "rpi-cli"
            ];
            doCheck = false;
            meta = {
              description = "rpi, a Rust agent runtime and CLI";
              license = lib.licenses.mit;
              mainProgram = "rpi";
            };
          };

          # rpi with the plugin on its extension path.
          rpi-with-402 = pkgs.symlinkJoin {
            name = "rpi-with-402";
            paths = [ rpi ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postBuild = ''
              wrapProgram $out/bin/rpi \
                --prefix RPI_EXTENSIONS_DIR : ${rpi-402}/lib/rpi/extensions
            '';
            meta.mainProgram = "rpi";
          };
        in
        {
          inherit rpi-402 rpi rpi-with-402;
          default = rpi-402;
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          meta.description = "rpi with the rpi-402 plugin loaded";
          program = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.rpi-with-402;
        };
      });

      checks = forAllSystems (pkgs: {
        # The plugin's unit and end-to-end tests run in its build.
        rpi-402 = self.packages.${pkgs.stdenv.hostPlatform.system}.rpi-402;

        rpi-revision =
          assert lib.assertMsg (lib.hasInfix "#${rpi-src.rev}" (builtins.readFile ./Cargo.lock))
            "Cargo.lock does not pin the rpi plugin SDK to the flake's rpi revision ${rpi-src.rev}";
          pkgs.runCommand "rpi-revision" { } "touch $out";
      });
    };
}
