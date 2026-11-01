// 存档格式检查：被桌面验证脚本使用，也可独立测试。
// 只做一件事：读取本次实际写入磁盘的存档文件，断言其 formatVersion
// 等于游戏当前格式版本。任何缺失/不可读/版本不一致都返回 ok:false，
// 绝不在脚本里硬编码预期版本。
const fs = require('node:fs');
const path = require('node:path');

function verifySaveFile(options) {
  const { savesDir, slot, storeFormatVersion } = options;
  const result = {
    ok: false,
    filePath: null,
    fileBytes: null,
    fileFormatVersion: null,
    fileGameVersion: null,
    listing: [],
    error: null,
  };
  try {
    if (typeof storeFormatVersion !== 'number' || !Number.isInteger(storeFormatVersion)) {
      throw new Error(`store.saveFormatVersion 不是整数：${JSON.stringify(storeFormatVersion)}`);
    }
    if (!fs.existsSync(savesDir)) throw new Error(`存档目录不存在：${savesDir}`);
    result.listing = fs.readdirSync(savesDir);
    const exact = path.join(savesDir, `${slot}.json`);
    const matched = result.listing
      .filter((name) => /\.json$/i.test(name))
      .map((name) => path.join(savesDir, name))
      .filter((full) => path.basename(full, path.extname(full)) === slot);
    const candidate = fs.existsSync(exact) ? exact : matched[0];
    if (!candidate) {
      throw new Error(
        `本次保存后未找到 ${slot} 存档文件；目录内容：${JSON.stringify(result.listing)}`,
      );
    }
    result.filePath = candidate;
    const raw = fs.readFileSync(candidate, 'utf8');
    result.fileBytes = Buffer.byteLength(raw, 'utf8');
    if (!raw.trim()) throw new Error(`存档文件为空：${candidate}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`存档文件不是有效 JSON：${candidate}（${message}）`);
    }
    result.fileFormatVersion = parsed && parsed.formatVersion !== undefined ? parsed.formatVersion : null;
    result.fileGameVersion =
      parsed && typeof parsed.gameVersion === 'string' ? parsed.gameVersion : null;
    if (!Number.isInteger(result.fileFormatVersion)) {
      throw new Error(`存档文件 formatVersion 不是整数：${JSON.stringify(result.fileFormatVersion)}`);
    }
    if (result.fileFormatVersion !== storeFormatVersion) {
      throw new Error(
        `存档文件 formatVersion=${result.fileFormatVersion} 与 store.saveFormatVersion=${storeFormatVersion} 不一致`,
      );
    }
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

module.exports = { verifySaveFile };
