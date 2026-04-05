const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildLaunchAgentLabel,
  buildLaunchdInstallGuide,
  buildLaunchdPlist,
  buildLaunchdShellScript,
  escapeXml,
  parseLaunchdConfig,
  sanitizeLaunchdLabelPart,
  writeLaunchdBundle,
} = require("../src/launchd");

/**
 * 作用：
 * 验证 launchd label 片段清洗会保留稳定的安全字符。
 *
 * 为什么这样写：
 * 生成的 label 同时影响 plist 文件名和 `launchctl` 命令。
 * 如果用户名或项目名中的特殊字符没有被正确处理，安装说明和系统加载都会变得不稳定。
 *
 * 输入：
 * @param {object} 无 - 直接调用清洗函数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只接受小写字母、数字和连字符。
 * - 清洗为空时必须回退到 `item`。
 */
test("sanitizeLaunchdLabelPart keeps launchd-safe characters only", () => {
  assert.equal(sanitizeLaunchdLabelPart("Mo.Li"), "mo-li");
  assert.equal(sanitizeLaunchdLabelPart("Poland Visa Checker"), "poland-visa-checker");
  assert.equal(sanitizeLaunchdLabelPart("###"), "item");
});

/**
 * 作用：
 * 验证默认 launchd label 使用用户名片段和固定项目后缀。
 *
 * 为什么这样写：
 * 默认 label 是用户最可能直接安装使用的值。
 * 这条测试锁住 label 规则，避免未来重构时把安装命令和生成文件名改散。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例用户名。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前格式固定为 `com.<user>.poland-visa-checker`。
 * - 用户名中的特殊字符应先被清洗。
 */
test("buildLaunchAgentLabel prefixes the sanitized username consistently", () => {
  assert.equal(buildLaunchAgentLabel("example.user"), "com.poland-visa-checker");
});

/**
 * 作用：
 * 验证 XML 转义函数会处理 plist 文本字段中的关键字符。
 *
 * 为什么这样写：
 * plist 内会出现绝对路径和环境变量。
 * 一旦 XML 特殊字符未转义，生成的 plist 可能直接无法被系统加载。
 *
 * 输入：
 * @param {object} 无 - 直接传入含特殊字符的示例文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证 plist 里最常见的 XML 特殊字符。
 * - 转义后的文本只用于 XML，不用于 shell。
 */
test("escapeXml protects special characters used inside plist files", () => {
  assert.equal(escapeXml(`A&B<"'`), "A&amp;B&lt;&quot;&apos;");
});

/**
 * 作用：
 * 验证 launchd 配置默认按 2 小时周期生成输出路径。
 *
 * 为什么这样写：
 * 用户明确要的是“每 2 小时自动运行一次”。
 * 这条测试锁住默认周期和输出目录约定，避免生成器默默漂移成别的间隔。
 *
 * 输入：
 * @param {object} 无 - 直接传入最小命令行参数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前默认输出目录是 `scheduler/`。
 * - 默认周期是 2 小时，对应 7200 秒。
 */
test("parseLaunchdConfig defaults to a two-hour schedule inside scheduler", () => {
  const cwd = path.resolve("/tmp/example-project");
  const config = parseLaunchdConfig(["node", "src/launchd.js"], cwd);

  assert.equal(config.outDir, path.join(cwd, "scheduler"));
  assert.equal(config.intervalHours, 2);
  assert.equal(config.intervalSeconds, 7200);
  assert.equal(config.label, "com.poland-visa-checker");
  assert.equal(
    config.plistPath,
    path.join(cwd, "scheduler", "poland-visa-checker.launchagent.plist")
  );
});

/**
 * 作用：
 * 验证 shell 脚本会调用当前项目里的单次检查入口。
 *
 * 为什么这样写：
 * launchd 调度层不应该引入新的业务逻辑。
 * 这条测试锁住“脚本只 cd 进项目并执行一次 `src/chrome-cli.js check`”这一契约。
 *
 * 输入：
 * @param {object} 无 - 构造一份示例配置后生成脚本文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 脚本必须引用绝对路径，避免 launchd 环境中的相对路径歧义。
 * - 脚本里不做死循环。
 */
test("buildLaunchdShellScript points launchd to the project check command", () => {
  const scriptText = buildLaunchdShellScript({});

  assert.match(scriptText, /SCRIPT_DIR="\$\(cd "\$\(dirname "\$0"\)" && pwd\)"/);
  assert.match(scriptText, /PROJECT_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(scriptText, /\/usr\/bin\/env node/);
  assert.match(scriptText, /src\/chrome-cli\.js" check/);
});

/**
 * 作用：
 * 验证 plist 会使用 7200 秒定时、绝对脚本路径和日志路径。
 *
 * 为什么这样写：
 * 这份 plist 就是用户最终复制到 `~/Library/LaunchAgents` 的文件。
 * 需要锁住最核心的 `StartInterval`、`ProgramArguments` 和日志落盘字段。
 *
 * 输入：
 * @param {object} 无 - 构造示例配置后生成 plist 文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前 `RunAtLoad` 默认开启，方便安装后立刻验证。
 * - `ProgramArguments` 只执行脚本，不在 plist 里拼复杂 shell。
 */
test("buildLaunchdPlist contains a two-hour StartInterval and bundle paths", () => {
  const plistText = buildLaunchdPlist({
    label: "com.poland-visa-checker",
    envPath: "/usr/bin:/bin",
    intervalSeconds: 7200,
    projectDirPlaceholder: "__PROJECT_DIR__",
    stdoutPathPlaceholder: "__PROJECT_DIR__/artifacts/logs/launchd.stdout.log",
    stderrPathPlaceholder: "__PROJECT_DIR__/artifacts/logs/launchd.stderr.log",
  });

  assert.match(plistText, /<string>com\.poland-visa-checker<\/string>/);
  assert.match(plistText, /<integer>7200<\/integer>/);
  assert.match(plistText, /run-check-every-2-hours\.sh/);
  assert.match(plistText, /launchd\.stdout\.log/);
  assert.match(plistText, /__PROJECT_DIR__/);
  assert.match(plistText, /<true\/>/);
});

/**
 * 作用：
 * 验证安装说明会给出复制、加载和查看状态的最短命令。
 *
 * 为什么这样写：
 * 用户的目标不是研究 launchd 语法，而是尽快把定时任务装起来。
 * 把最关键的安装命令锁进测试，可以避免说明文档和实际生成内容脱节。
 *
 * 输入：
 * @param {object} 无 - 构造示例配置后生成说明文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前说明假设用户手动复制到 `~/Library/LaunchAgents`。
 * - 若未来增加自动安装模式，这份说明仍应保留手动回退路径。
 */
test("buildLaunchdInstallGuide prints copy, load, and inspect commands", () => {
  const guideText = buildLaunchdInstallGuide({
    label: "com.poland-visa-checker",
    intervalHours: 2,
    launchAgentsPlistName: "com.poland-visa-checker.plist",
  });

  assert.match(guideText, /PROJECT_DIR="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/);
  assert.match(guideText, /sed "s\|__PROJECT_DIR__\|\$PROJECT_DIR\|g"/);
  assert.match(guideText, /launchctl load ~\/Library\/LaunchAgents\/com\.poland-visa-checker\.plist/);
  assert.match(guideText, /launchctl print gui\/\$\(id -u\)\/com\.poland-visa-checker/);
});

/**
 * 作用：
 * 验证 bundle 写入会生成脚本、plist 和安装说明三个文件。
 *
 * 为什么这样写：
 * 生成器的核心价值是“一次执行就得到完整可安装产物”。
 * 这条测试直接验证磁盘结果，避免后续重构时只剩部分文件或者忘记赋予脚本执行权限。
 *
 * 输入：
 * @param {object} 无 - 在临时目录里写入一份完整 bundle。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证仓库内生成行为，不触碰用户真实的 `~/Library/LaunchAgents`。
 * - shell 脚本应当是可执行文件。
 */
test("writeLaunchdBundle writes a complete launchd bundle inside the workspace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-launchd-test-"));
  const config = {
    cwd: "/Users/example/poland",
    outDir: tempDir,
    label: "com.poland-visa-checker",
    intervalHours: 2,
    intervalSeconds: 7200,
    scriptPath: path.join(tempDir, "run-check-every-2-hours.sh"),
    plistPath: path.join(tempDir, "poland-visa-checker.launchagent.plist"),
    installGuidePath: path.join(tempDir, "INSTALL.md"),
    projectDirPlaceholder: "__PROJECT_DIR__",
    stdoutPathPlaceholder: "__PROJECT_DIR__/artifacts/logs/launchd.stdout.log",
    stderrPathPlaceholder: "__PROJECT_DIR__/artifacts/logs/launchd.stderr.log",
    launchAgentsPlistName: "com.poland-visa-checker.plist",
    envPath: "/usr/bin:/bin",
  };

  const result = writeLaunchdBundle(config);
  const scriptMode = fs.statSync(result.scriptPath).mode & 0o777;

  assert.equal(fs.existsSync(result.scriptPath), true);
  assert.equal(fs.existsSync(result.plistPath), true);
  assert.equal(fs.existsSync(result.installGuidePath), true);
  assert.equal(scriptMode, 0o755);
});
