"use strict";

// https://serverless.com/blog/writing-serverless-plugins/
// https://serverless.com/framework/docs/providers/aws/guide/plugins/
// https://github.com/softprops/lambda-rust/

const { spawnSync } = require("child_process");
const { homedir, platform } = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { mkdirSync, writeFileSync, readFileSync } = require("fs");

const RUST_RUNTIME = "rust";
const BASE_RUNTIME = "provided.al2";
const NO_OUTPUT_CAPTURE = { stdio: ["ignore", process.stdout, process.stderr] };
const MUSL_PLATFORMS = ["darwin", "win32", "linux"];

function includeInvokeHook(serverlessVersion) {
  let [major, minor] = serverlessVersion.split(".");
  let majorVersion = parseInt(major);
  let minorVersion = parseInt(minor);
  return majorVersion === 1 && minorVersion >= 38 && minorVersion < 40;
}

/** assumes docker is on the host's execution path for containerized builds
 *  assumes cargo is on the host's execution path for local builds
 */
class RustPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.servicePath = this.serverless.config.servicePath || "";
    this.hooks = {
      "before:package:createDeploymentArtifacts": this.build.bind(this),
      "before:deploy:function:packageFunction": this.build.bind(this),
      "before:offline:start": this.build.bind(this),
      "before:offline:start:init": this.build.bind(this),
    };
    if (includeInvokeHook(serverless.version)) {
      this.hooks["before:invoke:local:invoke"] = this.build.bind(this);
    }
    this.custom = Object.assign(
      {
        cargoFlags: "",
      },
      (this.serverless.service.custom && this.serverless.service.custom.rust) ||
      {}
    );

    // Docker can't access resources outside of the current build directory.
    // This poses a problem if the serverless yaml is inside a workspace,
    // and we want pull in other packages from the workspace
    this.srcPath = path.resolve(this.custom.dockerPath || this.servicePath);

    // By default, Serverless examines node_modules to figure out which
    // packages there are from dependencies versus devDependencies of a
    // package. While there will always be a node_modules due to Serverless
    // and this plugin being installed, it will be excluded anyway.
    // Therefore, the filtering can be disabled to speed up (~3.2s) the process.
    this.serverless.service.package.excludeDevDependencies = false;
  }

  localBuildArgs(funcArgs, cargoPackage, binary, profile, platform) {
    const defaultArgs = ["build", "-p", cargoPackage];
    const profileArgs = profile !== "dev" ? ["--release"] : [];
    const cargoFlags = (
      (funcArgs || {}).cargoFlags ||
      this.custom.cargoFlags ||
      ""
    ).split(/\s+/);


    let target = (funcArgs || {}).target || this.custom.target

    const targetArgs =
      target ?
        ['--target', target]
        : MUSL_PLATFORMS.includes(platform)
          ? ["--target", "x86_64-unknown-linux-musl"]
          : [];
    return [
      ...defaultArgs,
      ...profileArgs,
      ...targetArgs,
      ...cargoFlags,
    ].filter((i) => i);
  }

  localBuildEnv(funcArgs, env, platform) {
    const defaultEnv = { ...env };

    let target = (funcArgs || {}).target || this.custom.target
    let linker = (funcArgs || {}).linker || this.custom.linker

    const platformEnv =
      linker ?
        {
          RUSTFLAGS: (env["RUSTFLAGS"] || "") + ` -Clinker=${linker}`,
          TARGET_CC: linker,
          [`CC_${target || 'x86_64_unknown_linux_musl'}`]: linker,
        }
        : "win32" === platform
          ? {
            RUSTFLAGS: (env["RUSTFLAGS"] || "") + " -Clinker=rust-lld",
            TARGET_CC: "rust-lld",
            CC_x86_64_unknown_linux_musl: "rust-lld",
          }
          : "darwin" === platform
            ? {
              RUSTFLAGS:
                (env["RUSTFLAGS"] || "") + " -Clinker=x86_64-linux-musl-gcc",
              TARGET_CC: "x86_64-linux-musl-gcc",
              CC_x86_64_unknown_linux_musl: "x86_64-linux-musl-gcc",
            }
            : {};
    return {
      ...defaultEnv,
      ...platformEnv,
    };
  }

  localSourceDir(funcArgs, profile, platform) {
    let target_directory_run = spawnSync('cargo', ['metadata']);
    if (target_directory_run.error || target_directory_run.status > 0) {
      throw error;
    }
    let target_directory = JSON.parse(target_directory_run.stdout).target_directory;
    console.log(target_directory_run)
    let executable = target_directory.toString();
    if (MUSL_PLATFORMS.includes(platform)) {
      let target = (funcArgs || {}).target || this.custom.target
      executable = path.join(executable, target ? target : "x86_64-unknown-linux-musl");
    }
    return path.join(executable, profile !== "dev" ? "release" : "debug");
  }

  localArtifactDir(profile) {
    return path.join(
      "target",
      "lambda",
      profile !== "dev" ? "release" : "debug"
    );
  }

  localBuild(funcArgs, cargoPackage, binary, profile) {
    const args = this.localBuildArgs(
      funcArgs,
      cargoPackage,
      binary,
      profile,
      platform()
    );

    const env = this.localBuildEnv(funcArgs, process.env, platform());
    this.serverless.cli.log(`Running local cargo build on ${platform()}`);

    const buildResult = spawnSync("cargo", args, {
      ...NO_OUTPUT_CAPTURE,
      ...{
        env: env,
      },
    });
    if (buildResult.error || buildResult.status > 0) {
      return buildResult;
    }
    // now rename binary and zip
    const sourceDir = this.localSourceDir(funcArgs, profile, platform());
    const zip = new AdmZip();
    zip.addFile(
      "bootstrap",
      readFileSync(path.join(sourceDir, binary)),
      "",
      0o755
    );
    const targetDir = this.localArtifactDir(profile);
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch { }
    try {
      writeFileSync(path.join(targetDir, `${binary}.zip`), zip.toBuffer());
      return {};
    } catch (err) {
      this.serverless.cli.log(`Error zipping artifact ${err}`);
      return {
        err: err,
        status: 1,
      };
    }
  }

  functions() {
    if (this.options.function) {
      return [this.options.function];
    } else {
      return this.serverless.service.getAllFunctions();
    }
  }

  cargoBinary(func) {
    let [cargoPackage, binary] = func.handler.split(".");
    if (binary == undefined) {
      binary = cargoPackage;
    }
    return { cargoPackage, binary };
  }

  /** the entry point for building functions */
  build() {
    const service = this.serverless.service;
    if (service.provider.name != "aws") {
      return;
    }
    let rustFunctionsFound = false;
    this.functions().forEach((funcName) => {
      const func = service.getFunction(funcName);
      const runtime = func.runtime || service.provider.runtime;
      if (runtime != RUST_RUNTIME) {
        // skip functions which don't apply to rust
        return;
      }
      rustFunctionsFound = true;
      const { cargoPackage, binary } = this.cargoBinary(func);

      this.serverless.cli.log(`Building Rust ${func.handler} func...`);
      let profile = (func.rust || {}).profile || this.custom.profile;

      const res = this.localBuild(func.rust, cargoPackage, binary, profile);
      if (res.error || res.status > 0) {
        this.serverless.cli.log(
          `Rust build encountered an error: ${res.error} ${res.status}.`
        );
        throw new Error(res.error);
      }
      // If all went well, we should now have find a packaged compiled binary under `target/lambda/release`.
      //
      // The AWS "provided" lambda runtime requires executables to be named
      // "bootstrap" -- https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
      //
      // To avoid artifact naming conflicts when we potentially have more than one function
      // we leverage the ability to declare a package artifact directly
      // see https://serverless.com/framework/docs/providers/aws/guide/packaging/
      // for more information
      const artifactPath = path.join(
        this.srcPath,
        `target/lambda/${"dev" === profile ? "debug" : "release"}`,
        `${binary}.zip`
      );
      func.package = func.package || {};
      func.package.artifact = artifactPath;

      // Ensure the runtime is set to a sane value for other plugins
      if (func.runtime == RUST_RUNTIME) {
        func.runtime = BASE_RUNTIME;
      }
    });
    if (service.provider.runtime === RUST_RUNTIME) {
      service.provider.runtime = BASE_RUNTIME;
    }
    if (!rustFunctionsFound) {
      throw new Error(
        `Error: no Rust functions found. ` +
        `Use 'runtime: ${RUST_RUNTIME}' in global or ` +
        `function configuration to use this plugin.`
      );
    }
  }
}

module.exports = RustPlugin;
