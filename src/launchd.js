const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * 作用：
 * 将任意文本片段清洗成适合 launchd label 使用的安全片段。
 *
 * 为什么这样写：
 * launchd label 通常会进入 plist 文件名、命令输出和 `launchctl` 命令。
 * 统一做一次保守清洗后，可以避免用户名、项目名中的特殊字符导致 label 不稳定。
 *
 * 输入：
 * @param {string} value - 原始文本片段。
 *
 * 输出：
 * @returns {string} 适合 launchd label 的安全片段。
 *
 * 注意：
 * - 当前只保留小写字母、数字和连字符。
 * - 清洗后为空时回退到 `item`，避免生成空 label 片段。
 */
function sanitizeLaunchdLabelPart(value) {
  const normalizedValue = String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return normalizedValue || "item";
}

/**
 * 作用：
 * 构造默认的 launchd Agent label。
 *
 * 为什么这样写：
 * 用户只需要“每 2 小时自动跑一次”的现成方案。
 * 用固定前后缀加用户名片段生成 label，可以让默认值直接可用，也尽量避免多项目冲突。
 *
 * 输入：
 * @param {string} username - 当前系统用户名。
 *
 * 输出：
 * @returns {string} 默认 launchd Agent label。
 *
 * 注意：
 * - 默认格式为 `com.<user>.poland-visa-checker`。
 * - 若未来项目名变化，文档和测试需要同步更新。
 */
function buildLaunchAgentLabel(username) {
  return `com.${sanitizeLaunchdLabelPart(username)}.poland-visa-checker`;
}

/**
 * 作用：
 * 将普通文本转义成 plist XML 可安全嵌入的值。
 *
 * 为什么这样写：
 * plist 模板里会写入绝对路径、环境变量和值。
 * 若不统一转义 `&`、`<` 等字符，生成出的 XML 可能无法被 `launchctl` 正常读取。
 *
 * 输入：
 * @param {string} value - 需要嵌入 XML 的原始文本。
 *
 * 输出：
 * @returns {string} 已转义的 XML 文本。
 *
 * 注意：
 * - 这里只处理 plist 文本字段常见字符。
 * - 若后续引入更复杂 XML 结构，需保持这里与模板一致。
 */
function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 作用：
 * 解析 launchd 生成命令所需的配置。
 *
 * 为什么这样写：
 * 这个生成器需要同时知道项目目录、输出目录、日志目录和执行间隔。
 * 把参数解析集中后，写文件和打印安装说明可以共享同一份配置。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 * @param {string} cwd - 当前项目目录。
 *
 * 输出：
 * @returns {object} 生成 launchd bundle 所需的完整配置。
 *
 * 注意：
 * - 默认每 2 小时运行一次，即 7200 秒。
 * - 当前只支持 `--out-dir` 和 `--interval-hours` 两个可选参数。
 */
function parseLaunchdConfig(argv, cwd) {
  const args = Array.isArray(argv) ? [...argv.slice(2)] : [];
  let outDir = path.resolve(cwd, "artifacts/launchd");
  let intervalHours = 2;

  for (let index = 0; index < args.length; index += 1) {
    const currentArg = args[index];

    if (currentArg === "--out-dir" && args[index + 1]) {
      outDir = path.resolve(cwd, args[index + 1]);
      index += 1;
      continue;
    }

    if (currentArg === "--interval-hours" && args[index + 1]) {
      intervalHours = Number(args[index + 1]);
      index += 1;
    }
  }

  const normalizedIntervalHours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 2;
  const label = buildLaunchAgentLabel(os.userInfo().username);
  const logDir = path.resolve(cwd, "artifacts/logs");
  const scriptPath = path.join(outDir, "run-check-every-2-hours.sh");
  const plistPath = path.join(outDir, `${label}.plist`);
  const installGuidePath = path.join(outDir, "INSTALL.md");

  return {
    cwd,
    outDir,
    logDir,
    label,
    nodePath: process.execPath,
    homeDir: os.homedir(),
    intervalHours: normalizedIntervalHours,
    intervalSeconds: Math.round(normalizedIntervalHours * 60 * 60),
    scriptPath,
    plistPath,
    installGuidePath,
    stdoutPath: path.join(logDir, "launchd.stdout.log"),
    stderrPath: path.join(logDir, "launchd.stderr.log"),
    envPath: process.env.PATH || "",
  };
}

/**
 * 作用：
 * 生成给 launchd 调用的单次检查脚本内容。
 *
 * 为什么这样写：
 * launchd 的执行环境与交互终端不同。
 * 用一个小脚本包住 `cd`、日志目录创建和 Node 调用后，定时任务会比直接在 plist 里拼长命令更稳。
 *
 * 输入：
 * @param {object} config - launchd bundle 配置。
 *
 * 输出：
 * @returns {string} 可直接写入 `.sh` 文件的脚本文本。
 *
 * 注意：
 * - 脚本内部只执行一次 `check`，不做死循环。
 * - 若仓库目录移动，需要重新生成这份脚本。
 */
function buildLaunchdShellScript(config) {
  return `#!/bin/zsh
: <<'DOC'
/**
 * 作用：
 * 作为 launchd 的真实执行入口，进入项目目录并运行一次单次检查。
 *
 * 为什么这样写：
 * launchd 自带的环境变量通常比交互终端更少。
 * 把目录切换、日志目录准备和 Node 入口固定下来后，定时任务的行为会更稳定。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {number} 进程退出码。
 *
 * 注意：
 * - 这里调用的是单次 \`check\`，不在脚本里重复调度。
 * - 若项目目录或 Node 路径变化，需要重新生成这份脚本。
 */
DOC

set -eu

PROJECT_DIR="${config.cwd}"
LOG_DIR="${config.logDir}"
NODE_BIN="${config.nodePath}"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"
"$NODE_BIN" "$PROJECT_DIR/src/chrome-cli.js" check
`;
}

/**
 * 作用：
 * 生成 launchd Agent plist 内容。
 *
 * 为什么这样写：
 * 用户需要一个“复制到 `~/Library/LaunchAgents` 就能用”的现成文件。
 * 直接把绝对路径、固定间隔和日志路径写进 plist，可以减少手工修改步骤。
 *
 * 输入：
 * @param {object} config - launchd bundle 配置。
 *
 * 输出：
 * @returns {string} plist XML 文本。
 *
 * 注意：
 * - 当前默认 `RunAtLoad` 为 true，方便安装后立刻验证。
 * - `StartInterval` 以秒为单位，默认每 7200 秒执行一次。
 */
function buildLaunchdPlist(config) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(config.homeDir)}</string>
    <key>PATH</key>
    <string>${escapeXml(config.envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${escapeXml(config.intervalSeconds)}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.stderrPath)}</string>
</dict>
</plist>
`;
}

/**
 * 作用：
 * 生成 launchd 安装说明文档。
 *
 * 为什么这样写：
 * 用户最终要把 plist 安装到 `~/Library/LaunchAgents`。
 * 与其让用户自己拼命令，不如把复制、加载、重载和查看状态的命令一起生成，降低出错概率。
 *
 * 输入：
 * @param {object} config - launchd bundle 配置。
 *
 * 输出：
 * @returns {string} Markdown 安装说明文本。
 *
 * 注意：
 * - 安装目录仍然是用户自己的 home 目录，不在仓库内直接写入。
 * - 若后续实际安装 label 改名，这里的命令也必须同步更新。
 */
function buildLaunchdInstallGuide(config) {
  return `# launchd Install Guide

This bundle runs the Poland visa checker every ${config.intervalHours} hours on macOS.

## Generated Files

- Script: \`${config.scriptPath}\`
- Plist: \`${config.plistPath}\`
- Stdout log: \`${config.stdoutPath}\`
- Stderr log: \`${config.stderrPath}\`

## Install

\`\`\`bash
mkdir -p ~/Library/LaunchAgents
cp "${config.plistPath}" ~/Library/LaunchAgents/${config.label}.plist
launchctl unload ~/Library/LaunchAgents/${config.label}.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/${config.label}.plist
launchctl kickstart -k gui/$(id -u)/${config.label}
\`\`\`

## Inspect Status

\`\`\`bash
launchctl print gui/$(id -u)/${config.label}
tail -f "${config.stdoutPath}"
tail -f "${config.stderrPath}"
\`\`\`

## Remove

\`\`\`bash
launchctl unload ~/Library/LaunchAgents/${config.label}.plist
rm -f ~/Library/LaunchAgents/${config.label}.plist
\`\`\`
`;
}

/**
 * 作用：
 * 将 launchd 所需脚本、plist 和安装说明写入输出目录。
 *
 * 为什么这样写：
 * 用户要求“直接制作一份”每 2 小时自动运行方案。
 * 把 bundle 写成独立目录后，用户可以先检查文件，再决定是否安装到系统目录。
 *
 * 输入：
 * @param {object} config - launchd bundle 配置。
 *
 * 输出：
 * @returns {object} 实际生成出的 bundle 路径信息。
 *
 * 注意：
 * - 这里只写仓库内文件，不直接修改 `~/Library/LaunchAgents`。
 * - shell 脚本会被赋予可执行权限。
 */
function writeLaunchdBundle(config) {
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });

  fs.writeFileSync(config.scriptPath, buildLaunchdShellScript(config));
  fs.chmodSync(config.scriptPath, 0o755);
  fs.writeFileSync(config.plistPath, buildLaunchdPlist(config));
  fs.writeFileSync(config.installGuidePath, buildLaunchdInstallGuide(config));

  return {
    label: config.label,
    scriptPath: config.scriptPath,
    plistPath: config.plistPath,
    installGuidePath: config.installGuidePath,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    intervalHours: config.intervalHours,
  };
}

/**
 * 作用：
 * 打印 launchd bundle 生成结果，方便用户直接执行后续安装命令。
 *
 * 为什么这样写：
 * 这个工具的目标不是只静默写文件，而是让用户一眼看到“文件在哪、下一步怎么装”。
 * 把关键信息压缩成 JSON 再附上最短安装提示，可读性和可复制性都更好。
 *
 * 输入：
 * @param {object} result - 写入后的 bundle 结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只输出建议安装命令，不会直接替用户执行系统级安装。
 * - 若未来增加自动安装模式，应与这个只生成模式保持分离。
 */
function printLaunchdBundleResult(result) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        label: result.label,
        intervalHours: result.intervalHours,
        scriptPath: result.scriptPath,
        plistPath: result.plistPath,
        installGuidePath: result.installGuidePath,
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
      },
      null,
      2
    )
  );
  console.log("");
  console.log("Next:");
  console.log(`1. Read ${result.installGuidePath}`);
  console.log(`2. Copy ${result.plistPath} to ~/Library/LaunchAgents/`);
  console.log(`3. Load it with launchctl`);
}

/**
 * 作用：
 * 作为 launchd bundle 生成器的命令行入口。
 *
 * 为什么这样写：
 * 定时任务生成逻辑与主 checker 逻辑是独立关注点。
 * 拆成单独入口后，用户可以单独生成或重生成调度文件，而不会影响单次检查流程。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只生成文件，不会自动安装到系统目录。
 * - 默认输出到 `artifacts/launchd/`。
 */
function main(argv) {
  const config = parseLaunchdConfig(argv, process.cwd());
  const result = writeLaunchdBundle(config);
  printLaunchdBundleResult(result);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildLaunchAgentLabel,
  buildLaunchdInstallGuide,
  buildLaunchdPlist,
  buildLaunchdShellScript,
  escapeXml,
  main,
  parseLaunchdConfig,
  printLaunchdBundleResult,
  sanitizeLaunchdLabelPart,
  writeLaunchdBundle,
};
