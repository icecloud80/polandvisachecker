const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const zlib = require("node:zlib");

const {
  prepareTrainingDataset,
  parseTrainingArgs,
} = require("./captcha-training");
const {
  getArtifactsDir,
  getCurrentCaptchaModelDir,
  getCurrentTrainingDir,
  getDataDir,
} = require("./project-paths");

/**
 * 作用：
 * 读取 JSON Lines 训练清单。
 *
 * 为什么这样写：
 * 本地训练脚本需要逐条读取训练导出结果，JSONL 比单一大 JSON 更方便流式消费和排查问题。
 *
 * 输入：
 * @param {string} filePath - JSONL 文件路径。
 *
 * 输出：
 * @returns {Array<object>} 解析后的记录数组。
 *
 * 注意：
 * - 会忽略空行。
 * - 解析失败会直接抛错，避免训练时吞掉坏记录。
 */
function readJsonLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * 作用：
 * 解析图片 data URL 并还原成二进制 buffer。
 *
 * 为什么这样写：
 * checker 实时拿到的是页面里的 data URL。
 * 训练脚本如果也能直接消费同一种格式，就不必为了模型推理额外落盘临时文件。
 *
 * 输入：
 * @param {string} dataUrl - 图片 data URL。
 *
 * 输出：
 * @returns {object} 包含 mimeType 和 buffer 的图片对象。
 *
 * 注意：
 * - 当前只支持 `data:image/...;base64,...`。
 * - 非法数据会直接抛错，避免模型 silently 吃脏数据。
 */
function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);

  if (!match) {
    throw new Error("Invalid image data URL.");
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

/**
 * 作用：
 * 计算 PNG 反滤波算法里的 Paeth 预测值。
 *
 * 为什么这样写：
 * 当前训练脚本不依赖第三方图片库，必须自己解码 PNG。
 * Paeth 是 PNG 标准滤波的一部分，缺了它就无法正确还原像素行。
 *
 * 输入：
 * @param {number} left - 当前像素左侧原始值。
 * @param {number} up - 当前像素上方原始值。
 * @param {number} upLeft - 当前像素左上方原始值。
 *
 * 输出：
 * @returns {number} Paeth 预测值。
 *
 * 注意：
 * - 输入和输出都按 0-255 的单字节值处理。
 * - 这里只服务于 PNG 8-bit 非隔行图像解码。
 */
function paethPredictor(left, up, upLeft) {
  const base = left + up - upLeft;
  const leftDistance = Math.abs(base - left);
  const upDistance = Math.abs(base - up);
  const upLeftDistance = Math.abs(base - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }

  if (upDistance <= upLeftDistance) {
    return up;
  }

  return upLeft;
}

/**
 * 作用：
 * 对 PNG 解压后的逐行数据执行反滤波。
 *
 * 为什么这样写：
 * PNG 文件里存的不是直接像素，而是带滤波的扫描行。
 * 先把它还原成真实像素字节，后面的灰度化和分割才有意义。
 *
 * 输入：
 * @param {Buffer} inflated - zlib 解压后的原始扫描行。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {number} bytesPerPixel - 每个像素的字节数。
 *
 * 输出：
 * @returns {Uint8Array} 反滤波后的像素字节数组。
 *
 * 注意：
 * - 当前只支持 8-bit 非隔行 PNG。
 * - 扫描行长度异常时会直接抛错。
 */
function unfilterPngScanlines(inflated, width, height, bytesPerPixel) {
  const rowLength = width * bytesPerPixel;
  const expectedLength = height * (rowLength + 1);

  if (inflated.length !== expectedLength) {
    throw new Error(
      `PNG inflated byte length mismatch. Expected ${expectedLength}, got ${inflated.length}.`
    );
  }

  const result = new Uint8Array(width * height * bytesPerPixel);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * (rowLength + 1);
    const targetOffset = row * rowLength;
    const filterType = inflated[sourceOffset];

    for (let column = 0; column < rowLength; column += 1) {
      const rawValue = inflated[sourceOffset + 1 + column];
      const left =
        column >= bytesPerPixel ? result[targetOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? result[targetOffset + column - rowLength] : 0;
      const upLeft =
        row > 0 && column >= bytesPerPixel
          ? result[targetOffset + column - rowLength - bytesPerPixel]
          : 0;
      let value = rawValue;

      if (filterType === 1) {
        value = (rawValue + left) & 0xff;
      } else if (filterType === 2) {
        value = (rawValue + up) & 0xff;
      } else if (filterType === 3) {
        value = (rawValue + Math.floor((left + up) / 2)) & 0xff;
      } else if (filterType === 4) {
        value = (rawValue + paethPredictor(left, up, upLeft)) & 0xff;
      } else if (filterType !== 0) {
        throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }

      result[targetOffset + column] = value;
    }
  }

  return result;
}

/**
 * 作用：
 * 解码当前项目里的 PNG captcha 图片。
 *
 * 为什么这样写：
 * 训练脚本必须在“零额外安装”的前提下本地可跑，因此这里直接支持当前数据集使用的 PNG RGB 格式。
 *
 * 输入：
 * @param {Buffer} buffer - PNG 文件完整字节内容。
 *
 * 输出：
 * @returns {object} 包含宽高、通道数和像素字节数组的图片对象。
 *
 * 注意：
 * - 当前支持 colorType 0、2、4、6 的 8-bit PNG。
 * - 如果未来采集格式变化成 WebP/JPEG，需要新增解码分支。
 */
function decodePng(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");

  if (signature !== "89504e470d0a1a0a") {
    throw new Error("Unsupported image signature. Expected PNG.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;
    const chunkData = buffer.subarray(chunkDataStart, chunkDataEnd);

    if (chunkType === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlaceMethod = chunkData[12];
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = chunkDataEnd + 4;
  }

  if (!width || !height) {
    throw new Error("PNG header is missing width or height.");
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }

  if (interlaceMethod !== 0) {
    throw new Error("Unsupported PNG interlace method.");
  }

  const bytesPerPixelByColorType = {
    0: 1,
    2: 3,
    4: 2,
    6: 4,
  };
  const bytesPerPixel = bytesPerPixelByColorType[colorType];

  if (!bytesPerPixel) {
    throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const data = unfilterPngScanlines(inflated, width, height, bytesPerPixel);

  return {
    width,
    height,
    bitDepth,
    colorType,
    bytesPerPixel,
    data,
  };
}

/**
 * 作用：
 * 从文件系统加载本地 captcha 原型模型。
 *
 * 为什么这样写：
 * checker 运行时只需要消费已经训练好的模型，不应该重复解析训练过程里的其他产物。
 * 单独封装模型加载入口后，CLI 和测试都可以共享同一套契约。
 *
 * 输入：
 * @param {string} modelPath - `model.json` 文件路径。
 *
 * 输出：
 * @returns {object} 解析后的模型对象。
 *
 * 注意：
 * - 当前要求文件结构包含 `model.labels` 和 `model.prototypes`。
 * - 文件缺失或结构不完整时会直接抛错。
 */
function loadLocalCaptchaModel(modelPath) {
  const payload = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const model = payload && payload.model;

  if (
    !model ||
    !Array.isArray(model.labels) ||
    !model.prototypes ||
    typeof model.prototypes !== "object"
  ) {
    throw new Error("Invalid local captcha model payload.");
  }

  return model;
}

/**
 * 作用：
 * 把 PNG 像素转换成灰度值数组。
 *
 * 为什么这样写：
 * 当前 captcha 字符是深色、背景是浅色，用灰度值就足够支撑阈值化和字符分割。
 *
 * 输入：
 * @param {object} image - 解码后的图片对象。
 *
 * 输出：
 * @returns {Uint8Array} 长度为 width * height 的灰度数组。
 *
 * 注意：
 * - 对 RGBA/灰度 PNG 也做了兼容，但当前主数据集是 RGB。
 * - alpha 为 0 的像素会被视作白底。
 */
function buildGrayscalePixels(image) {
  const width = Number(image && image.width);
  const height = Number(image && image.height);
  const bytesPerPixel = Number(image && image.bytesPerPixel);
  const source = image && image.data;
  const result = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * bytesPerPixel;
    let red = 255;
    let green = 255;
    let blue = 255;
    let alpha = 255;

    if (bytesPerPixel === 1) {
      red = source[sourceOffset];
      green = red;
      blue = red;
    } else if (bytesPerPixel === 2) {
      red = source[sourceOffset];
      green = red;
      blue = red;
      alpha = source[sourceOffset + 1];
    } else if (bytesPerPixel === 3) {
      red = source[sourceOffset];
      green = source[sourceOffset + 1];
      blue = source[sourceOffset + 2];
    } else if (bytesPerPixel === 4) {
      red = source[sourceOffset];
      green = source[sourceOffset + 1];
      blue = source[sourceOffset + 2];
      alpha = source[sourceOffset + 3];
    }

    const blendedRed = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
    const blendedGreen = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
    const blendedBlue = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
    result[index] = Math.round(
      blendedRed * 0.299 + blendedGreen * 0.587 + blendedBlue * 0.114
    );
  }

  return result;
}

/**
 * 作用：
 * 为灰度图计算 Otsu 阈值。
 *
 * 为什么这样写：
 * captcha 背景带有渐变和噪点，固定阈值容易忽亮忽暗。
 * Otsu 至少能给第一版模型一个自适应的二值化起点。
 *
 * 输入：
 * @param {Uint8Array} grayscale - 灰度数组。
 * @param {number[]} indices - 参与统计的像素索引列表。
 *
 * 输出：
 * @returns {number} 推荐阈值。
 *
 * 注意：
 * - 如果样本为空，会退回默认阈值 160。
 * - 当前只区分深色字符和浅色背景两类。
 */
function computeOtsuThreshold(grayscale, indices) {
  const histogram = new Array(256).fill(0);
  const sampledIndices = Array.isArray(indices) ? indices : [];

  if (sampledIndices.length === 0) {
    return 160;
  }

  for (const index of sampledIndices) {
    histogram[grayscale[index]] += 1;
  }

  const total = sampledIndices.length;
  let totalSum = 0;

  for (let value = 0; value < 256; value += 1) {
    totalSum += value * histogram[value];
  }

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestThreshold = 160;
  let bestVariance = -1;

  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold];

    if (backgroundWeight === 0) {
      continue;
    }

    const foregroundWeight = total - backgroundWeight;

    if (foregroundWeight === 0) {
      break;
    }

    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const betweenClassVariance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) *
      (backgroundMean - foregroundMean);

    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance;
      bestThreshold = threshold;
    }
  }

  return Math.max(60, Math.min(190, bestThreshold));
}

/**
 * 作用：
 * 生成 captcha 字符的初始二值掩码。
 *
 * 为什么这样写：
 * 顶部和底部的波浪边框很深，直接全图阈值化会把边框一起当成字符。
 * 这里先限制中心采样区域，再把结果扩展回全图。
 *
 * 输入：
 * @param {Uint8Array} grayscale - 灰度像素数组。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 *
 * 输出：
 * @returns {object} 包含阈值、掩码和中心区域边界的对象。
 *
 * 注意：
 * - 掩码里 1 表示深色前景，0 表示背景。
 * - 当前默认跳过离边缘过近的区域，避免边框干扰。
 */
function createInitialBinaryMask(grayscale, width, height) {
  const leftMargin = Math.max(6, Math.floor(width * 0.05));
  const rightMargin = width - leftMargin;
  const topMargin = Math.max(10, Math.floor(height * 0.14));
  const bottomMargin = height - topMargin;
  const sampleIndices = [];

  for (let y = topMargin; y < bottomMargin; y += 1) {
    for (let x = leftMargin; x < rightMargin; x += 1) {
      sampleIndices.push(y * width + x);
    }
  }

  const threshold = computeOtsuThreshold(grayscale, sampleIndices);
  const mask = new Uint8Array(width * height);

  for (let y = topMargin; y < bottomMargin; y += 1) {
    for (let x = leftMargin; x < rightMargin; x += 1) {
      const index = y * width + x;
      mask[index] = grayscale[index] <= threshold ? 1 : 0;
    }
  }

  return {
    threshold,
    mask,
    cropBox: {
      minX: leftMargin,
      maxX: rightMargin - 1,
      minY: topMargin,
      maxY: bottomMargin - 1,
    },
  };
}

/**
 * 作用：
 * 对二值掩码做一次轻量去噪。
 *
 * 为什么这样写：
 * captcha 背景里有散点噪声。
 * 在第一版模型里先用邻居数量过滤掉孤立点，能明显减轻分割抖动。
 *
 * 输入：
 * @param {Uint8Array} mask - 原始二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 *
 * 输出：
 * @returns {Uint8Array} 去噪后的二值掩码。
 *
 * 注意：
 * - 这里不会做重型形态学操作，尽量保持实现简单。
 * - 如果字符笔画很细，阈值过高可能会误删，后续可再调。
 */
function denoiseBinaryMask(mask, width, height) {
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;

      if (!mask[index]) {
        continue;
      }

      let neighborCount = 0;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }

          const nextX = x + offsetX;
          const nextY = y + offsetY;

          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }

          neighborCount += mask[nextY * width + nextX];
        }
      }

      if (neighborCount >= 1) {
        result[index] = 1;
      }
    }
  }

  return result;
}

/**
 * 作用：
 * 找出前景像素的紧致外接框。
 *
 * 为什么这样写：
 * 后续 4 字分割要尽量基于文字本体，而不是整张 200x100 图片。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 *
 * 输出：
 * @returns {object|null} 前景包围盒；没有前景时返回 null。
 *
 * 注意：
 * - 返回边界都是闭区间。
 * - 当前不会主动扩边，外部调用方可自行加 margin。
 */
function findMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
  };
}

/**
 * 作用：
 * 在图片边界内扩展包围盒。
 *
 * 为什么这样写：
 * 分割字符时给一点 margin，能避免笔画贴边被裁掉。
 *
 * 输入：
 * @param {object} bounds - 原始包围盒。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {number} margin - 四周扩展像素数。
 *
 * 输出：
 * @returns {object} 扩展后的包围盒。
 *
 * 注意：
 * - 如果传入空包围盒，会回退到整张图的中心安全区。
 * - 返回边界仍然是闭区间。
 */
function expandBounds(bounds, width, height, margin) {
  if (!bounds) {
    return {
      minX: Math.max(0, Math.floor(width * 0.1)),
      maxX: Math.min(width - 1, Math.ceil(width * 0.9) - 1),
      minY: Math.max(0, Math.floor(height * 0.18)),
      maxY: Math.min(height - 1, Math.ceil(height * 0.82) - 1),
    };
  }

  return {
    minX: Math.max(0, bounds.minX - margin),
    maxX: Math.min(width - 1, bounds.maxX + margin),
    minY: Math.max(0, bounds.minY - margin),
    maxY: Math.min(height - 1, bounds.maxY + margin),
  };
}

/**
 * 作用：
 * 计算指定区域内每一列的前景像素数量。
 *
 * 为什么这样写：
 * 4 字 captcha 的天然切分点通常出现在字符之间的低像素谷值。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 统计区域边界。
 *
 * 输出：
 * @returns {number[]} 从左到右的列投影数组。
 *
 * 注意：
 * - 只统计边界框内部的像素。
 * - 返回数组长度等于边界框宽度。
 */
function buildColumnProjection(mask, width, bounds) {
  const projection = [];

  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    let count = 0;

    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      count += mask[y * width + x];
    }

    projection.push(count);
  }

  return projection;
}

/**
 * 作用：
 * 为 4 字验证码选择 3 个分割边界。
 *
 * 为什么这样写：
 * 当前验证码字符宽度并不完全平均。
 * 这里在“尽量等宽”和“尽量切在低谷”之间做折中，比死板四等分更稳一点。
 *
 * 输入：
 * @param {number[]} projection - 列投影数组。
 *
 * 输出：
 * @returns {number[]} 五个边界索引，表示 4 个字符区间。
 *
 * 注意：
 * - 返回值基于 `projection` 的局部索引，不是整图坐标。
 * - 当前默认最小字符宽度为总宽度的约 12%。
 */
function chooseGlyphBoundaries(projection) {
  const width = projection.length;
  const minWidth = Math.max(6, Math.floor(width * 0.12));
  const targetWidth = width / 4;
  let bestBoundaries = [0, Math.floor(width / 4), Math.floor(width / 2), Math.floor((width * 3) / 4), width];
  let bestScore = Number.POSITIVE_INFINITY;

  for (let first = minWidth; first <= width - minWidth * 3; first += 1) {
    for (let second = first + minWidth; second <= width - minWidth * 2; second += 1) {
      for (let third = second + minWidth; third <= width - minWidth; third += 1) {
        const widths = [
          first,
          second - first,
          third - second,
          width - third,
        ];
        const cutPenalty =
          projection[Math.max(0, first - 1)] +
          projection[Math.min(width - 1, first)] +
          projection[Math.max(0, second - 1)] +
          projection[Math.min(width - 1, second)] +
          projection[Math.max(0, third - 1)] +
          projection[Math.min(width - 1, third)];
        const widthPenalty = widths.reduce(
          (sum, currentWidth) => sum + Math.abs(currentWidth - targetWidth),
          0
        );
        const score = cutPenalty * 8 + widthPenalty;

        if (score < bestScore) {
          bestScore = score;
          bestBoundaries = [0, first, second, third, width];
        }
      }
    }
  }

  return bestBoundaries;
}

/**
 * 作用：
 * 从列分割结果中提取单个字符的紧致边界框。
 *
 * 为什么这样写：
 * 用局部字符框再做向量化，可以减少每个字符左右空白差异对原型模型的影响。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {object} bounds - 整体文字边界框。
 * @param {number} startX - 字符起始局部列索引。
 * @param {number} endX - 字符结束局部列索引。
 *
 * 输出：
 * @returns {object} 单字符边界框。
 *
 * 注意：
 * - 如果局部区域没有前景，会退回到对应切片区域。
 * - 返回边界会额外加 1 像素 margin，减少切边。
 */
function extractGlyphBounds(mask, width, height, bounds, startX, endX) {
  const absoluteMinX = bounds.minX + startX;
  const absoluteMaxX = bounds.minX + endX - 1;
  let minX = absoluteMaxX;
  let minY = bounds.maxY;
  let maxX = absoluteMinX;
  let maxY = bounds.minY;
  let found = false;

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = absoluteMinX; x <= absoluteMaxX; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      found = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!found) {
    return {
      minX: Math.max(0, absoluteMinX),
      maxX: Math.min(width - 1, absoluteMaxX),
      minY: Math.max(0, bounds.minY),
      maxY: Math.min(height - 1, bounds.maxY),
    };
  }

  return expandBounds(
    {
      minX,
      maxX,
      minY,
      maxY,
    },
    width,
    height,
    1
  );
}

/**
 * 作用：
 * 把字符区域采样成固定长度向量。
 *
 * 为什么这样写：
 * 第一版训练脚本采用原型分类器，只需要把每个字符变成固定维度的占据率向量即可。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 * @param {number} outputWidth - 输出向量网格宽度。
 * @param {number} outputHeight - 输出向量网格高度。
 *
 * 输出：
 * @returns {number[]} 归一化后的字符向量。
 *
 * 注意：
 * - 每个特征值范围是 0-1。
 * - 这里用区域平均占据率，不做复杂仿射校正。
 */
function vectorizeMaskRegion(mask, width, bounds, outputWidth, outputHeight) {
  const sourceWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const sourceHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
  const vector = [];

  for (let row = 0; row < outputHeight; row += 1) {
    const rowStart = bounds.minY + Math.floor((row * sourceHeight) / outputHeight);
    const rowEnd =
      bounds.minY + Math.floor(((row + 1) * sourceHeight) / outputHeight) - 1;

    for (let column = 0; column < outputWidth; column += 1) {
      const columnStart = bounds.minX + Math.floor((column * sourceWidth) / outputWidth);
      const columnEnd =
        bounds.minX + Math.floor(((column + 1) * sourceWidth) / outputWidth) - 1;
      let count = 0;
      let total = 0;

      for (let y = rowStart; y <= Math.max(rowStart, rowEnd); y += 1) {
        for (let x = columnStart; x <= Math.max(columnStart, columnEnd); x += 1) {
          count += mask[y * width + x];
          total += 1;
        }
      }

      vector.push(total > 0 ? count / total : 0);
    }
  }

  return vector;
}

/**
 * 作用：
 * 构建指定区域内逐行的前景像素投影。
 *
 * 为什么这样写：
 * 仅靠网格占据率还不够稳定地区分衬线体字符。
 * 逐行投影可以补充“哪些高度更黑、更有笔画”的整体结构信息。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 统计区域边界。
 *
 * 输出：
 * @returns {number[]} 逐行前景计数数组。
 *
 * 注意：
 * - 返回数组长度等于字符区域高度。
 * - 这里只统计边界框内部像素。
 */
function buildRowProjection(mask, width, bounds) {
  const projection = [];

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    let count = 0;

    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      count += mask[y * width + x];
    }

    projection.push(count);
  }

  return projection;
}

/**
 * 作用：
 * 把任意长度的数值序列重采样到固定长度。
 *
 * 为什么这样写：
 * 投影、边缘轮廓和转折特征的原始长度都随字符框变化。
 * 重采样后才能把这些结构特征稳定拼进同一条固定长度向量。
 *
 * 输入：
 * @param {number[]} values - 原始数值序列。
 * @param {number} targetLength - 目标长度。
 * @param {number} normalizer - 归一化分母。
 *
 * 输出：
 * @returns {number[]} 固定长度的归一化序列。
 *
 * 注意：
 * - 输入为空时会返回全 0。
 * - `normalizer` 小于等于 0 时会回退到 1，避免除零。
 */
function resampleNumericSequence(values, targetLength, normalizer = 1) {
  const source = Array.isArray(values) ? values : [];
  const safeNormalizer = normalizer > 0 ? normalizer : 1;

  if (targetLength <= 0) {
    return [];
  }

  if (source.length === 0) {
    return new Array(targetLength).fill(0);
  }

  const result = [];

  for (let index = 0; index < targetLength; index += 1) {
    const start = Math.floor((index * source.length) / targetLength);
    const end = Math.max(start + 1, Math.floor(((index + 1) * source.length) / targetLength));
    let sum = 0;
    let count = 0;

    for (let sourceIndex = start; sourceIndex < Math.min(source.length, end); sourceIndex += 1) {
      sum += source[sourceIndex];
      count += 1;
    }

    result.push(Number(((count > 0 ? sum / count : 0) / safeNormalizer).toFixed(6)));
  }

  return result;
}

/**
 * 作用：
 * 统计单条 0/1 序列里的笔画转折次数。
 *
 * 为什么这样写：
 * 衬线体字符的一个重要区别是横竖主干和端点转折模式。
 * 用二值序列里的前景状态变化次数，可以补充字符骨架的复杂度信息。
 *
 * 输入：
 * @param {number[]} values - 单条 0/1 序列。
 *
 * 输出：
 * @returns {number} 转折次数。
 *
 * 注意：
 * - 只统计相邻元素之间的 0/1 变化。
 * - 输入为空时返回 0。
 */
function countBinaryTransitions(values) {
  const source = Array.isArray(values) ? values : [];
  let transitions = 0;

  for (let index = 1; index < source.length; index += 1) {
    if (source[index] !== source[index - 1]) {
      transitions += 1;
    }
  }

  return transitions;
}

/**
 * 作用：
 * 提取字符区域的逐行与逐列转折特征。
 *
 * 为什么这样写：
 * 仅看黑像素总量不够区分 `# / H`、`= / t`、`C / c` 这类形近字符。
 * 逐行逐列的转折数可以更直接反映主干、横杠和端点结构。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 * @param {number} outputWidth - 行方向特征长度。
 * @param {number} outputHeight - 列方向特征长度。
 *
 * 输出：
 * @returns {object} 包含 rowTransitions 和 columnTransitions 的特征对象。
 *
 * 注意：
 * - 特征值会按对应宽高归一化到 0-1 左右的量级。
 * - 返回的两个数组长度分别对应 `outputHeight` 和 `outputWidth`。
 */
function buildTransitionFeatures(mask, width, bounds, outputWidth, outputHeight) {
  const rowTransitions = [];
  const columnTransitions = [];
  const glyphWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const glyphHeight = Math.max(1, bounds.maxY - bounds.minY + 1);

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    const row = [];

    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      row.push(mask[y * width + x]);
    }

    rowTransitions.push(countBinaryTransitions(row));
  }

  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const column = [];

    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      column.push(mask[y * width + x]);
    }

    columnTransitions.push(countBinaryTransitions(column));
  }

  return {
    rowTransitions: resampleNumericSequence(rowTransitions, outputHeight, glyphWidth),
    columnTransitions: resampleNumericSequence(columnTransitions, outputWidth, glyphHeight),
  };
}

/**
 * 作用：
 * 计算字符区域的整体墨水密度。
 *
 * 为什么这样写：
 * `=`、`+`、`#`、`H` 这类字符虽然局部结构接近，但整体黑像素占比差异仍然明显。
 * 单独记录墨水密度可以减少分割误差对纯形状匹配的影响。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 *
 * 输出：
 * @returns {number} 0-1 范围内的墨水密度。
 *
 * 注意：
 * - 区域为空时返回 0。
 * - 当前把前景像素视作 1，背景像素视作 0。
 */
function computeForegroundDensity(mask, width, bounds) {
  let foregroundCount = 0;
  let totalCount = 0;

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      foregroundCount += mask[y * width + x];
      totalCount += 1;
    }
  }

  return totalCount > 0 ? Number((foregroundCount / totalCount).toFixed(6)) : 0;
}

/**
 * 作用：
 * 计算字符前景的重心位置。
 *
 * 为什么这样写：
 * 大小写衬线体字符往往在重心位置上有稳定差异。
 * 例如 `P / p`、`C / c`、`K / k` 的重心偏移，对分类有实际帮助。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 *
 * 输出：
 * @returns {object} 归一化后的重心坐标。
 *
 * 注意：
 * - 没有前景时回退到几何中心。
 * - 输出范围大致在 0-1。
 */
function computeForegroundCenterOfMass(mask, width, bounds) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const glyphWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const glyphHeight = Math.max(1, bounds.maxY - bounds.minY + 1);

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      sumX += x - bounds.minX;
      sumY += y - bounds.minY;
      count += 1;
    }
  }

  if (count === 0) {
    return {
      x: 0.5,
      y: 0.5,
    };
  }

  return {
    x: Number((sumX / count / glyphWidth).toFixed(6)),
    y: Number((sumY / count / glyphHeight).toFixed(6)),
  };
}

/**
 * 作用：
 * 统计字符在边缘方向上的首个前景距离轮廓。
 *
 * 为什么这样写：
 * 衬线体最重要的先验之一就是端点突起与边缘形态。
 * 记录顶部、底部、左右边缘的首个前景距离，可以让模型更直接感知 serif 轮廓。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 * @param {string} direction - `top`、`bottom`、`left` 或 `right`。
 * @param {number} sampleCount - 重采样后的输出长度。
 *
 * 输出：
 * @returns {number[]} 归一化后的边缘轮廓序列。
 *
 * 注意：
 * - 未找到前景时会把距离记为整段长度，表示该切片为空。
 * - 输出值归一化到 0-1 左右，越小表示前景越靠近该边缘。
 */
function buildEdgeDistanceProfile(mask, width, bounds, direction, sampleCount) {
  const values = [];
  const glyphWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const glyphHeight = Math.max(1, bounds.maxY - bounds.minY + 1);

  if (direction === "top" || direction === "bottom") {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      let distance = glyphHeight;

      for (let offset = 0; offset < glyphHeight; offset += 1) {
        const y = direction === "top" ? bounds.minY + offset : bounds.maxY - offset;

        if (mask[y * width + x]) {
          distance = offset;
          break;
        }
      }

      values.push(distance);
    }

    return resampleNumericSequence(values, sampleCount, glyphHeight);
  }

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    let distance = glyphWidth;

    for (let offset = 0; offset < glyphWidth; offset += 1) {
      const x = direction === "left" ? bounds.minX + offset : bounds.maxX - offset;

      if (mask[y * width + x]) {
        distance = offset;
        break;
      }
    }

    values.push(distance);
  }

  return resampleNumericSequence(values, sampleCount, glyphWidth);
}

/**
 * 作用：
 * 从单个字符框中抽取组合特征向量。
 *
 * 为什么这样写：
 * 纯 occupancy grid 容易把衬线体 hard cases 混在一起。
 * 这里把网格、投影、转折、密度、重心和边缘轮廓一起拼成一条特征向量，提高区分大小写和符号的能力。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {object} bounds - 字符边界框。
 * @param {number} outputWidth - 网格特征宽度。
 * @param {number} outputHeight - 网格特征高度。
 *
 * 输出：
 * @returns {object} 包含组合向量和辅助度量的特征对象。
 *
 * 注意：
 * - 特征向量会对不同子模块施加不同权重。
 * - 返回的 `metrics` 也会被后续分割质量与分析报告复用。
 */
function extractGlyphFeatureVector(mask, width, bounds, outputWidth, outputHeight) {
  const glyphWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const glyphHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
  const occupancyVector = vectorizeMaskRegion(mask, width, bounds, outputWidth, outputHeight).map(
    (value) => Number((value * 0.7).toFixed(6))
  );
  const rowProjection = resampleNumericSequence(
    buildRowProjection(mask, width, bounds),
    outputHeight,
    glyphWidth
  ).map((value) => Number((value * 1.05).toFixed(6)));
  const columnProjection = resampleNumericSequence(
    buildColumnProjection(mask, width, bounds),
    outputWidth,
    glyphHeight
  ).map((value) => Number((value * 1.05).toFixed(6)));
  const transitions = buildTransitionFeatures(mask, width, bounds, outputWidth, outputHeight);
  const topEdgeProfile = buildEdgeDistanceProfile(mask, width, bounds, "top", outputWidth).map(
    (value) => Number((value * 1.2).toFixed(6))
  );
  const bottomEdgeProfile = buildEdgeDistanceProfile(
    mask,
    width,
    bounds,
    "bottom",
    outputWidth
  ).map((value) => Number((value * 1.2).toFixed(6)));
  const leftEdgeProfile = buildEdgeDistanceProfile(mask, width, bounds, "left", outputHeight).map(
    (value) => Number((value * 1.15).toFixed(6))
  );
  const rightEdgeProfile = buildEdgeDistanceProfile(
    mask,
    width,
    bounds,
    "right",
    outputHeight
  ).map((value) => Number((value * 1.15).toFixed(6)));
  const density = computeForegroundDensity(mask, width, bounds);
  const center = computeForegroundCenterOfMass(mask, width, bounds);
  const scalarFeatures = [
    Number((density * 1.1).toFixed(6)),
    Number((glyphWidth / glyphHeight).toFixed(6)),
    Number(center.x.toFixed(6)),
    Number(center.y.toFixed(6)),
  ];

  return {
    vector: [
      ...occupancyVector,
      ...rowProjection,
      ...columnProjection,
      ...transitions.rowTransitions,
      ...transitions.columnTransitions,
      ...topEdgeProfile,
      ...bottomEdgeProfile,
      ...leftEdgeProfile,
      ...rightEdgeProfile,
      ...scalarFeatures,
    ],
    metrics: {
      density,
      aspectRatio: Number((glyphWidth / glyphHeight).toFixed(6)),
      centerX: center.x,
      centerY: center.y,
      glyphWidth,
      glyphHeight,
    },
  };
}

/**
 * 作用：
 * 在指定区域内搜索前景连通块。
 *
 * 为什么这样写：
 * 单纯列投影在字符粘连或空隙偏移时容易漂。
 * 连通块可以作为辅助定位，让我们在“4 个明显主块存在”时更稳地构造备用切分。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {object} bounds - 搜索区域边界。
 *
 * 输出：
 * @returns {Array<object>} 连通块列表。
 *
 * 注意：
 * - 当前按 8 邻域搜索。
 * - 体积非常小的噪点仍会被返回，调用方需要自行过滤。
 */
function findConnectedComponents(mask, width, height, bounds) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = [];

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const startIndex = y * width + x;

      if (!mask[startIndex] || visited[startIndex]) {
        continue;
      }

      visited[startIndex] = 1;
      queue.push(startIndex);
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let pixelCount = 0;

      while (queue.length > 0) {
        const current = queue.shift();
        const currentY = Math.floor(current / width);
        const currentX = current - currentY * width;

        pixelCount += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) {
              continue;
            }

            const nextX = currentX + offsetX;
            const nextY = currentY + offsetY;

            if (
              nextX < bounds.minX ||
              nextX > bounds.maxX ||
              nextY < bounds.minY ||
              nextY > bounds.maxY
            ) {
              continue;
            }

            const nextIndex = nextY * width + nextX;

            if (!mask[nextIndex] || visited[nextIndex]) {
              continue;
            }

            visited[nextIndex] = 1;
            queue.push(nextIndex);
          }
        }
      }

      components.push({
        minX,
        maxX,
        minY,
        maxY,
        pixelCount,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
    }
  }

  return components;
}

/**
 * 作用：
 * 基于等宽假设构造一套备用字符边界。
 *
 * 为什么这样写：
 * 当列投影谷值极弱时，至少要有一套稳定可比较的保底切分。
 * 等宽分割虽然不总是最好，但作为备用候选很有价值。
 *
 * 输入：
 * @param {number[]} projection - 列投影数组。
 *
 * 输出：
 * @returns {number[]} 五个边界索引。
 *
 * 注意：
 * - 返回值始终覆盖完整宽度。
 * - 这里只负责构造候选，不负责判断优劣。
 */
function buildEqualWidthGlyphBoundaries(projection) {
  const width = Array.isArray(projection) ? projection.length : 0;
  return [
    0,
    Math.floor(width * 0.25),
    Math.floor(width * 0.5),
    Math.floor(width * 0.75),
    width,
  ];
}

/**
 * 作用：
 * 尝试用连通块结构构造更贴近字符本体的备用切分。
 *
 * 为什么这样写：
 * 当前 captcha 很多字符间仍有可分离的主连通块。
 * 在能识别出 4 个主要块时，用它们的中点来切分，通常比纯等宽更接近真实字符边界。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {object} bounds - 整体文字边界框。
 *
 * 输出：
 * @returns {number[]|null} 五个局部边界索引；无法构造时返回 null。
 *
 * 注意：
 * - 这里只使用面积最大的 4 个主块。
 * - 若主块不足 4 个，则认为该方法不适用。
 */
function buildComponentGuidedBoundaries(mask, width, height, bounds) {
  const components = findConnectedComponents(mask, width, height, bounds)
    .filter((component) => component.pixelCount >= 4)
    .sort((left, right) => right.pixelCount - left.pixelCount)
    .slice(0, 4)
    .sort((left, right) => left.minX - right.minX);

  if (components.length !== 4) {
    return null;
  }

  const boundaries = [0];

  for (let index = 0; index < components.length - 1; index += 1) {
    const left = components[index];
    const right = components[index + 1];
    const splitX = Math.max(
      bounds.minX,
      Math.min(bounds.maxX + 1, Math.round((left.maxX + right.minX + 1) / 2))
    );

    boundaries.push(splitX - bounds.minX);
  }

  boundaries.push(bounds.maxX - bounds.minX + 1);
  return boundaries;
}

/**
 * 作用：
 * 评估一套字符切分的稳定性与质量。
 *
 * 为什么这样写：
 * 现在 checker 不应把“明显坏分割”的图也浪费成一次提交。
 * 先给切分打分，训练和 live 都能基于同一份质量指标做判断。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {object} bounds - 整体文字边界框。
 * @param {number[]} boundaries - 候选边界。
 * @param {number[]} projection - 列投影数组。
 *
 * 输出：
 * @returns {object} 包含 penalty、quality 和辅助细节的打分结果。
 *
 * 注意：
 * - `quality` 越接近 1 越好。
 * - 这里只评估相对质量，不等价于真正的识别置信度。
 */
function scoreGlyphSegmentation(mask, width, height, bounds, boundaries, projection) {
  const glyphBoundsList = [];
  const widths = [];
  const densities = [];
  const glyphHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
  const cutPenalty =
    projection[Math.max(0, (boundaries[1] || 0) - 1)] +
    projection[Math.min(projection.length - 1, boundaries[1] || 0)] +
    projection[Math.max(0, (boundaries[2] || 0) - 1)] +
    projection[Math.min(projection.length - 1, boundaries[2] || 0)] +
    projection[Math.max(0, (boundaries[3] || 0) - 1)] +
    projection[Math.min(projection.length - 1, boundaries[3] || 0)];
  const normalizedCutPenalty = Number(
    (cutPenalty / Math.max(1, glyphHeight * 6)).toFixed(6)
  );

  for (let index = 0; index < 4; index += 1) {
    const glyphBounds = extractGlyphBounds(
      mask,
      width,
      height,
      bounds,
      boundaries[index],
      boundaries[index + 1]
    );

    glyphBoundsList.push(glyphBounds);
    widths.push(Math.max(1, glyphBounds.maxX - glyphBounds.minX + 1));
    densities.push(computeForegroundDensity(mask, width, glyphBounds));
  }

  const meanWidth = widths.reduce((sum, current) => sum + current, 0) / widths.length;
  const meanDensity = densities.reduce((sum, current) => sum + current, 0) / densities.length;
  const widthVariance =
    widths.reduce((sum, current) => sum + (current - meanWidth) * (current - meanWidth), 0) /
    widths.length;
  const densityVariance =
    densities.reduce((sum, current) => sum + (current - meanDensity) * (current - meanDensity), 0) /
    densities.length;
  const widthConsistency = Number((Math.sqrt(widthVariance) / Math.max(1, meanWidth)).toFixed(6));
  const inkDensityBalance = Number(Math.sqrt(densityVariance).toFixed(6));
  const serifEdgeTruncationRisk = Number(
    (
      glyphBoundsList.filter(
        (glyphBounds) =>
          glyphBounds.minY <= bounds.minY + 1 || glyphBounds.maxY >= bounds.maxY - 1
      ).length / glyphBoundsList.length
    ).toFixed(6)
  );
  const boundaryValleyStrength = Number((1 - Math.min(1, normalizedCutPenalty)).toFixed(6));
  const totalPenalty = Number(
    (
      widthConsistency * 1.6 +
      inkDensityBalance * 1.4 +
      normalizedCutPenalty * 1.3 +
      serifEdgeTruncationRisk * 0.9
    ).toFixed(6)
  );
  const quality = Number(Math.max(0, Math.min(1, 1 - totalPenalty / 2.8)).toFixed(6));

  return {
    penalty: totalPenalty,
    quality,
    widthConsistency,
    inkDensityBalance,
    serifEdgeTruncationRisk,
    boundaryValleyStrength,
    glyphBoundsList,
  };
}

/**
 * 作用：
 * 在多套候选切分里选出当前最稳的一套。
 *
 * 为什么这样写：
 * 当前计划要求分割升级成双分支，并把 connected-component 作为辅助定位。
 * 这里统一比较列投影切分、等宽切分和连通块引导切分，保证训练和 live 共用同一条决策逻辑。
 *
 * 输入：
 * @param {Uint8Array} mask - 二值掩码。
 * @param {number} width - 图片宽度。
 * @param {number} height - 图片高度。
 * @param {object} bounds - 整体文字边界框。
 * @param {number[]} projection - 列投影数组。
 *
 * 输出：
 * @returns {object} 选中的边界和完整诊断结果。
 *
 * 注意：
 * - 当前至少会比较主切分和等宽切分两套方案。
 * - 若连通块方案不可用，会自动跳过而不报错。
 */
function selectBestGlyphSegmentation(mask, width, height, bounds, projection) {
  const candidates = [
    {
      method: "projection",
      boundaries: chooseGlyphBoundaries(projection),
    },
    {
      method: "equal-width",
      boundaries: buildEqualWidthGlyphBoundaries(projection),
    },
  ];
  const componentGuidedBoundaries = buildComponentGuidedBoundaries(mask, width, height, bounds);

  if (Array.isArray(componentGuidedBoundaries)) {
    candidates.push({
      method: "components",
      boundaries: componentGuidedBoundaries,
    });
  }

  const scoredCandidates = candidates.map((candidate) => ({
    ...candidate,
    score: scoreGlyphSegmentation(
      mask,
      width,
      height,
      bounds,
      candidate.boundaries,
      projection
    ),
  }));
  const selected = scoredCandidates.sort((left, right) => left.score.penalty - right.score.penalty)[0];

  return {
    selectedMethod: selected.method,
    boundaries: selected.boundaries,
    segmentationQuality: selected.score.quality,
    segmentationScore: selected.score,
    candidateScores: scoredCandidates.map((candidate) => ({
      method: candidate.method,
      penalty: candidate.score.penalty,
      quality: candidate.score.quality,
      widthConsistency: candidate.score.widthConsistency,
      inkDensityBalance: candidate.score.inkDensityBalance,
      serifEdgeTruncationRisk: candidate.score.serifEdgeTruncationRisk,
      boundaryValleyStrength: candidate.score.boundaryValleyStrength,
    })),
  };
}

/**
 * 作用：
 * 从单张 captcha 图片中提取 4 个字符向量。
 *
 * 为什么这样写：
 * 训练和推理都要走同一条预处理链路。
 * 把“解码 + 二值化 + 分割 + 向量化”封装成一个入口，后面评估更稳定。
 *
 * 输入：
 * @param {string} imagePath - captcha 图片路径。
 * @param {object} options - 预处理与向量尺寸配置。
 *
 * 输出：
 * @returns {object} 包含字符向量、阈值和边界信息的对象。
 *
 * 注意：
 * - 当前默认输出 4 个字符向量。
 * - 如果掩码为空，会退回到中心区域和等分分割。
 */
function extractCaptchaGlyphVectors(imagePath, options = {}) {
  const image = decodePng(fs.readFileSync(imagePath));

  return extractCaptchaGlyphVectorsFromDecodedImage(image, options);
}

/**
 * 作用：
 * 从图片 data URL 中提取 4 个字符向量。
 *
 * 为什么这样写：
 * checker 拿到的 captcha 图片来源于页面 data URL。
 * 直接在内存里完成解码和特征提取，可以少一次临时文件写入。
 *
 * 输入：
 * @param {string} dataUrl - captcha 图片 data URL。
 * @param {object} options - 预处理与向量尺寸配置。
 *
 * 输出：
 * @returns {object} 包含字符向量、阈值和边界信息的对象。
 *
 * 注意：
 * - 当前仅支持 PNG data URL。
 * - 如果页面未来返回 JPEG/WebP，需要扩展这里的解码分支。
 */
function extractCaptchaGlyphVectorsFromDataUrl(dataUrl, options = {}) {
  const parsedImage = parseImageDataUrl(dataUrl);
  const image = decodePng(parsedImage.buffer);

  return extractCaptchaGlyphVectorsFromDecodedImage(image, options);
}

/**
 * 作用：
 * 从已解码图片对象中提取 4 个字符向量。
 *
 * 为什么这样写：
 * 文件路径和 data URL 两种入口最后都会汇聚到同一条特征提取链路。
 * 把真正的图像处理逻辑集中在这里，可以避免两套实现漂移。
 *
 * 输入：
 * @param {object} image - 已解码图片对象。
 * @param {object} options - 预处理与向量尺寸配置。
 *
 * 输出：
 * @returns {object} 包含字符向量、阈值和边界信息的对象。
 *
 * 注意：
 * - 当前默认输出 4 个字符向量。
 * - 如果掩码为空，会退回到中心区域和等分分割。
 */
function extractCaptchaGlyphVectorsFromDecodedImage(image, options = {}) {
  const vectorWidth = Number(options.vectorWidth || 18);
  const vectorHeight = Number(options.vectorHeight || 22);
  const grayscale = buildGrayscalePixels(image);
  const initialMaskResult = createInitialBinaryMask(grayscale, image.width, image.height);
  const mask = denoiseBinaryMask(initialMaskResult.mask, image.width, image.height);
  const roughBounds = expandBounds(
    findMaskBounds(mask, image.width, image.height) || initialMaskResult.cropBox,
    image.width,
    image.height,
    1
  );
  const bounds = expandBounds(
    findMaskBounds(mask, image.width, image.height) || roughBounds,
    image.width,
    image.height,
    1
  );
  const projection = buildColumnProjection(mask, image.width, bounds);
  const segmentation = selectBestGlyphSegmentation(
    mask,
    image.width,
    image.height,
    bounds,
    projection
  );
  const boundaries = segmentation.boundaries;
  const glyphVectors = [];
  const glyphMetrics = [];

  for (let index = 0; index < 4; index += 1) {
    const glyphBounds = extractGlyphBounds(
      mask,
      image.width,
      image.height,
      bounds,
      boundaries[index],
      boundaries[index + 1]
    );
    const featureVector = extractGlyphFeatureVector(
      mask,
      image.width,
      glyphBounds,
      vectorWidth,
      vectorHeight
    );

    glyphVectors.push(featureVector.vector);
    glyphMetrics.push({
      ...featureVector.metrics,
      bounds: glyphBounds,
    });
  }

  return {
    glyphVectors,
    glyphMetrics,
    threshold: initialMaskResult.threshold,
    bounds,
    boundaries,
    segmentation,
    width: image.width,
    height: image.height,
  };
}

/**
 * 作用：
 * 对两个同维度向量计算平方欧氏距离。
 *
 * 为什么这样写：
 * 原型分类器要找“最像哪个字符”，平方欧氏距离实现简单，也足够支撑第一版基线。
 *
 * 输入：
 * @param {number[]} left - 左侧向量。
 * @param {number[]} right - 右侧向量。
 *
 * 输出：
 * @returns {number} 距离值，越小越相似。
 *
 * 注意：
 * - 两个向量长度必须一致。
 * - 这里不做额外归一化，向量本身已经是 0-1 占据率。
 */
function squaredDistance(left, right) {
  if (left.length !== right.length) {
    throw new Error("Vector length mismatch.");
  }

  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    total += delta * delta;
  }

  return total;
}

/**
 * 作用：
 * 从带标签的字符向量集合中构建字符原型模型。
 *
 * 为什么这样写：
 * 这是第一版本地训练脚本的核心。
 * 用每个字符的平均向量做原型，训练成本极低，足够先验证“标注数据是否真的可学”。
 *
 * 输入：
 * @param {Array<object>} samples - 形如 `{ label, vector }` 的字符样本。
 *
 * 输出：
 * @returns {object} 原型模型。
 *
 * 注意：
 * - 这里假设每个样本标签都是单字符。
 * - 模型里会记录每个字符的样本数，方便后续观察分布。
 */
function buildPrototypeModel(samples) {
  const groups = new Map();

  for (const sample of Array.isArray(samples) ? samples : []) {
    const label = String((sample && sample.label) || "");
    const vector = Array.isArray(sample && sample.vector) ? sample.vector : [];

    if (!label || vector.length === 0) {
      continue;
    }

    if (!groups.has(label)) {
      groups.set(label, {
        count: 0,
        sum: new Array(vector.length).fill(0),
      });
    }

    const group = groups.get(label);
    group.count += 1;

    for (let index = 0; index < vector.length; index += 1) {
      group.sum[index] += vector[index];
    }
  }

  const prototypes = {};

  for (const [label, group] of Array.from(groups.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    prototypes[label] = {
      count: group.count,
      vector: group.sum.map((value) => Number((value / group.count).toFixed(6))),
    };
  }

  return {
    labels: Object.keys(prototypes),
    prototypes,
  };
}

/**
 * 作用：
 * 按字符位置和标签把训练样本分组。
 *
 * 为什么这样写：
 * 这批 captcha 在第 1 位和第 4 位的分割偏差最明显。
 * 先做位置分组后，后续 exemplar 和多原型都能优先学习“同一位置上的真实形态”。
 *
 * 输入：
 * @param {Array<object>} samples - 字符样本数组。
 *
 * 输出：
 * @returns {Map<string, Array<object>>} 以 `position:label` 为 key 的分组结果。
 *
 * 注意：
 * - 只接收带 position、label、vector 的完整样本。
 * - 返回值是 Map，方便后续保持确定性遍历顺序。
 */
function groupCharacterSamplesByPositionAndLabel(samples) {
  const groups = new Map();

  for (const sample of Array.isArray(samples) ? samples : []) {
    const position = Number(sample && sample.position);
    const label = String((sample && sample.label) || "");
    const vector = Array.isArray(sample && sample.vector) ? sample.vector : [];

    if (!Number.isInteger(position) || position < 0 || !label || vector.length === 0) {
      continue;
    }

    const key = `${position}:${label}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(sample);
  }

  return groups;
}

/**
 * 作用：
 * 从一组样本里挑出代表性的 exemplar 子集。
 *
 * 为什么这样写：
 * 把所有样本都塞进模型虽然最直接，但 JSON 会越来越大。
 * 用确定性的 farthest-point 近似挑一小批代表样本，能兼顾覆盖率和模型体积。
 *
 * 输入：
 * @param {Array<object>} samples - 同标签同位置的样本数组。
 * @param {number} limit - 最多保留多少个 exemplar。
 *
 * 输出：
 * @returns {Array<object>} 代表性 exemplar 列表。
 *
 * 注意：
 * - 当前算法是确定性的，不引入随机数。
 * - 样本数不超过上限时会原样返回。
 */
function selectRepresentativeExemplars(samples, limit) {
  const source = Array.isArray(samples) ? samples : [];
  const exemplarLimit = Math.max(1, Number(limit || 1));

  if (source.length <= exemplarLimit) {
    return [...source];
  }

  const selected = [source[0]];
  const remaining = source.slice(1);

  while (selected.length < exemplarLimit && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const picked of selected) {
        nearestDistance = Math.min(nearestDistance, squaredDistance(candidate.vector, picked.vector));
      }

      if (nearestDistance > bestDistance) {
        bestDistance = nearestDistance;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

/**
 * 作用：
 * 为同一位置同一标签的样本构建多个形态簇原型。
 *
 * 为什么这样写：
 * 同一个字符在当前 captcha 里并不是单一均值形态。
 * 用多个子原型覆盖不同扭曲/粗细/位姿，可以明显降低 `C/c`、`P/p`、`#/H` 这类混淆。
 *
 * 输入：
 * @param {Array<object>} samples - 同标签同位置的样本数组。
 * @param {number} clusterCount - 最多生成多少个子原型。
 *
 * 输出：
 * @returns {Array<object>} 多原型列表。
 *
 * 注意：
 * - 当前采用确定性的 farthest-seed + 最近分配。
 * - 这里只在单组内部建簇，不做跨标签聚类。
 */
function buildMultiPrototypeClusters(samples, clusterCount) {
  const source = Array.isArray(samples) ? samples : [];
  const maxClusterCount = Math.max(1, Math.min(source.length, Number(clusterCount || 1)));

  if (source.length === 0) {
    return [];
  }

  if (source.length === 1 || maxClusterCount === 1) {
    return [
      {
        count: source.length,
        vector: source[0].vector.map((value) => Number(value.toFixed(6))),
      },
    ];
  }

  const seeds = selectRepresentativeExemplars(source, maxClusterCount).map((sample) => sample.vector);
  const clusters = seeds.map((seed) => ({
    count: 0,
    sum: new Array(seed.length).fill(0),
  }));

  for (const sample of source) {
    let bestClusterIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < seeds.length; index += 1) {
      const distance = squaredDistance(sample.vector, seeds[index]);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestClusterIndex = index;
      }
    }

    const cluster = clusters[bestClusterIndex];
    cluster.count += 1;

    for (let index = 0; index < sample.vector.length; index += 1) {
      cluster.sum[index] += sample.vector[index];
    }
  }

  return clusters
    .filter((cluster) => cluster.count > 0)
    .map((cluster) => ({
      count: cluster.count,
      vector: cluster.sum.map((value) => Number((value / cluster.count).toFixed(6))),
    }));
}

/**
 * 作用：
 * 构建按字符位置组织的 exemplar 索引。
 *
 * 为什么这样写：
 * live 识别最容易被“同字符不同位置”的分割差异拖慢。
 * 位置感知 exemplar 让预测时优先参考同一位置的真实样本形状。
 *
 * 输入：
 * @param {Array<object>} samples - 单字符样本数组。
 * @param {number} exemplarLimit - 每个位置/标签最多保留多少 exemplar。
 *
 * 输出：
 * @returns {object} 位置感知 exemplar 索引。
 *
 * 注意：
 * - 索引结果会直接写进模型 JSON。
 * - exemplar 只保留必要字段，避免模型文件过大。
 */
function buildPositionAwareExemplarIndex(samples, exemplarLimit) {
  const groups = groupCharacterSamplesByPositionAndLabel(samples);
  const index = {};

  for (const [key, group] of Array.from(groups.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const [positionText, label] = key.split(":");
    const position = String(positionText);

    if (!index[position]) {
      index[position] = {};
    }

    index[position][label] = selectRepresentativeExemplars(group, exemplarLimit).map((sample) => ({
      sampleId: sample.sampleId,
      vector: sample.vector.map((value) => Number(value.toFixed(6))),
    }));
  }

  return index;
}

/**
 * 作用：
 * 构建按字符位置组织的多原型索引。
 *
 * 为什么这样写：
 * 相比单均值 prototype，多原型能覆盖同字符的多个衬线形态簇。
 * 再叠加位置维度后，能更稳地处理当前 captcha 的位置偏差。
 *
 * 输入：
 * @param {Array<object>} samples - 单字符样本数组。
 * @param {number} clusterCount - 每个位置/标签最多保留多少个子原型。
 *
 * 输出：
 * @returns {object} 位置感知多原型索引。
 *
 * 注意：
 * - 索引结果会直接写进模型 JSON。
 * - 当前 cluster 数量固定，由训练配置决定。
 */
function buildPositionAwarePrototypeIndex(samples, clusterCount) {
  const groups = groupCharacterSamplesByPositionAndLabel(samples);
  const index = {};

  for (const [key, group] of Array.from(groups.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const [positionText, label] = key.split(":");
    const position = String(positionText);

    if (!index[position]) {
      index[position] = {};
    }

    index[position][label] = buildMultiPrototypeClusters(group, clusterCount);
  }

  return index;
}

/**
 * 作用：
 * 计算当前字符在某个标签下的混合距离分数。
 *
 * 为什么这样写：
 * 当前计划要求把分类器升级成“位置 exemplar + 位置多原型 + 全局原型”的混合打分。
 * 单独抽出这一步后，训练评估、top-k 排序和 live checker 都能复用同一条评分规则。
 *
 * 输入：
 * @param {number[]} vector - 待预测字符向量。
 * @param {object} model - 本地模型。
 * @param {number} position - 当前字符位置。
 * @param {string} label - 候选标签。
 *
 * 输出：
 * @returns {object} 当前标签的打分明细。
 *
 * 注意：
 * - 没有某一层索引时，会自动跳过对应分量。
 * - 返回值中的 `score` 越小越好。
 */
function scoreCharacterLabel(vector, model, position, label) {
  const globalPrototype = model && model.prototypes ? model.prototypes[label] : null;
  const positionKey = String(position);
  const positionPrototypeList =
    model &&
    model.positionPrototypes &&
    model.positionPrototypes[positionKey] &&
    Array.isArray(model.positionPrototypes[positionKey][label])
      ? model.positionPrototypes[positionKey][label]
      : [];
  const positionExemplars =
    model &&
    model.positionExemplars &&
    model.positionExemplars[positionKey] &&
    Array.isArray(model.positionExemplars[positionKey][label])
      ? model.positionExemplars[positionKey][label]
      : [];
  const exemplarDistance =
    positionExemplars.length > 0
      ? Math.min(...positionExemplars.map((exemplar) => squaredDistance(vector, exemplar.vector)))
      : Number.POSITIVE_INFINITY;
  const positionPrototypeDistance =
    positionPrototypeList.length > 0
      ? Math.min(...positionPrototypeList.map((prototype) => squaredDistance(vector, prototype.vector)))
      : Number.POSITIVE_INFINITY;
  const globalPrototypeDistance = globalPrototype
    ? squaredDistance(vector, globalPrototype.vector)
    : Number.POSITIVE_INFINITY;
  const weightedParts = [];

  if (Number.isFinite(exemplarDistance)) {
    weightedParts.push({ weight: 0.15, value: exemplarDistance });
  }

  if (Number.isFinite(positionPrototypeDistance)) {
    weightedParts.push({ weight: 0.25, value: positionPrototypeDistance });
  }

  if (Number.isFinite(globalPrototypeDistance)) {
    weightedParts.push({ weight: 0.6, value: globalPrototypeDistance });
  }

  const totalWeight = weightedParts.reduce((sum, current) => sum + current.weight, 0);
  const score =
    totalWeight > 0
      ? weightedParts.reduce((sum, current) => sum + current.value * current.weight, 0) / totalWeight
      : Number.POSITIVE_INFINITY;

  return {
    label,
    score: Number(score.toFixed(6)),
    exemplarDistance: Number.isFinite(exemplarDistance)
      ? Number(exemplarDistance.toFixed(6))
      : null,
    positionPrototypeDistance: Number.isFinite(positionPrototypeDistance)
      ? Number(positionPrototypeDistance.toFixed(6))
      : null,
    globalPrototypeDistance: Number.isFinite(globalPrototypeDistance)
      ? Number(globalPrototypeDistance.toFixed(6))
      : null,
  };
}

/**
 * 作用：
 * 用字符模型预测单个字符向量，并返回 top-k 排名。
 *
 * 为什么这样写：
 * 当前计划要求训练报告和 live artifact 都保留 top-k。
 * 先把每个标签的分数都算出来，再统一排序，就能同时满足 top-1 和分析需求。
 *
 * 输入：
 * @param {number[]} vector - 待预测字符向量。
 * @param {object} model - 原型模型。
 * @param {number} position - 当前字符位置。
 * @param {number} topK - 最多返回多少个候选标签。
 *
 * 输出：
 * @returns {object} 最佳标签、距离和 top-k 排名。
 *
 * 注意：
 * - 如果模型为空会直接抛错。
 * - 返回的 `distance` 等于 top-1 的混合分数。
 */
function predictCharacterVector(vector, model, position = 0, topK = 3) {
  const labels = Array.isArray(model && model.labels) ? model.labels : [];

  if (labels.length === 0) {
    throw new Error("Prototype model is empty.");
  }

  const ranked = labels
    .map((label) => scoreCharacterLabel(vector, model, position, label))
    .sort((left, right) => left.score - right.score);
  const best = ranked[0];

  return {
    label: best.label,
    distance: best.score,
    topK: ranked.slice(0, Math.max(1, topK)),
  };
}

/**
 * 作用：
 * 对 4 个字符向量做整串预测。
 *
 * 为什么这样写：
 * 最终 captcha 判断按整串进行，训练报告也需要同时看字符准确率和整串准确率。
 *
 * 输入：
 * @param {number[][]} glyphVectors - 4 个字符向量。
 * @param {object} model - 原型模型。
 *
 * 输出：
 * @returns {object} 包含整串文本和逐字符细节的预测结果。
 *
 * 注意：
 * - 当前默认输入长度为 4。
 * - 返回的 `distances` 与字符位置一一对应。
 */
function predictCaptchaText(glyphVectors, model) {
  const predictions = glyphVectors.map((vector, index) =>
    predictCharacterVector(vector, model, index, 3)
  );
  const confidenceParts = predictions.map((prediction) => {
    const bestDistance = prediction.distance;
    const runnerUpDistance =
      Array.isArray(prediction.topK) && prediction.topK[1]
        ? prediction.topK[1].score
        : Number.POSITIVE_INFINITY;

    if (!Number.isFinite(bestDistance) || !Number.isFinite(runnerUpDistance) || runnerUpDistance <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(1, (runnerUpDistance - bestDistance) / runnerUpDistance));
  });
  const averageConfidence =
    confidenceParts.length > 0
      ? confidenceParts.reduce((sum, current) => sum + current, 0) / confidenceParts.length
      : 0;

  return {
    text: predictions.map((prediction) => prediction.label).join(""),
    characters: predictions.map((prediction) => prediction.label),
    distances: predictions.map((prediction) => prediction.distance),
    topK: predictions.map((prediction) => prediction.topK),
    confidence: Number(Math.max(0, Math.min(1, averageConfidence)).toFixed(6)),
  };
}

/**
 * 作用：
 * 用本地原型模型直接预测一张 data URL captcha。
 *
 * 为什么这样写：
 * checker 实时提交前最需要的是“给当前图片一个 4 位猜测和可信度分数”。
 * 这里把特征提取、逐字符分类和整体打分打包在一起，便于主流程直接消费。
 *
 * 输入：
 * @param {string} dataUrl - captcha 图片 data URL。
 * @param {object} model - 已加载的本地原型模型。
 * @param {object} options - 预处理配置。
 *
 * 输出：
 * @returns {object} 本地模型预测结果。
 *
 * 注意：
 * - `averageDistance` 越低通常越可信，但不是绝对概率。
 * - 当前仍然会始终返回 4 位预测字符，由上层决定是否提交。
 */
function predictCaptchaDataUrl(dataUrl, model, options = {}) {
  const extraction = extractCaptchaGlyphVectorsFromDataUrl(dataUrl, options);
  const prediction = predictCaptchaText(extraction.glyphVectors, model);
  const averageDistance =
    prediction.distances.length > 0
      ? prediction.distances.reduce((sum, current) => sum + current, 0) / prediction.distances.length
      : Number.POSITIVE_INFINITY;

  return {
    text: prediction.text,
    characters: prediction.characters,
    distances: prediction.distances,
    averageDistance: Number(averageDistance.toFixed(6)),
    confidence: prediction.confidence,
    topK: prediction.topK,
    threshold: extraction.threshold,
    bounds: extraction.bounds,
    boundaries: extraction.boundaries,
    glyphMetrics: extraction.glyphMetrics,
    segmentation: extraction.segmentation,
  };
}

/**
 * 作用：
 * 用本地原型模型直接预测一张本地 PNG captcha 图片。
 *
 * 为什么这样写：
 * `captcha:suggest` 面对的是磁盘上的采集图片，而不是浏览器里的 data URL。
 * 增加这个入口后，标注预填和 live checker 就能共享同一套本地模型，不再依赖 Tesseract。
 *
 * 输入：
 * @param {string} imagePath - captcha 图片文件路径。
 * @param {object} model - 已加载的本地原型模型。
 * @param {object} options - 预处理配置。
 *
 * 输出：
 * @returns {object} 本地模型预测结果。
 *
 * 注意：
 * - 返回结构刻意与 `predictCaptchaDataUrl()` 保持一致，方便上层复用。
 * - 输入图片当前要求为 PNG；若后续要支持其他格式，需要扩展解码入口。
 */
function predictCaptchaImagePath(imagePath, model, options = {}) {
  const extraction = extractCaptchaGlyphVectors(imagePath, options);
  const prediction = predictCaptchaText(extraction.glyphVectors, model);
  const averageDistance =
    prediction.distances.length > 0
      ? prediction.distances.reduce((sum, current) => sum + current, 0) / prediction.distances.length
      : Number.POSITIVE_INFINITY;

  return {
    text: prediction.text,
    characters: prediction.characters,
    distances: prediction.distances,
    averageDistance: Number(averageDistance.toFixed(6)),
    confidence: prediction.confidence,
    topK: prediction.topK,
    threshold: extraction.threshold,
    bounds: extraction.bounds,
    boundaries: extraction.boundaries,
    glyphMetrics: extraction.glyphMetrics,
    segmentation: extraction.segmentation,
  };
}

/**
 * 作用：
 * 从训练记录中展开单字符训练样本。
 *
 * 为什么这样写：
 * 原型模型是按单字符学习的。
 * 先把 4 位验证码拆成 4 条字符样本，后续训练和统计都会简单很多。
 *
 * 输入：
 * @param {Array<object>} records - 训练记录数组。
 * @param {string} trainingDir - 训练目录绝对路径。
 * @param {object} options - 预处理配置。
 *
 * 输出：
 * @returns {Array<object>} 单字符训练样本数组。
 *
 * 注意：
 * - 会直接读取图片文件。
 * - 这里假设 `text` 长度已经在导出阶段校验为 4。
 */
function buildCharacterSamples(records, trainingDir, options) {
  const samples = [];

  for (const record of Array.isArray(records) ? records : []) {
    const imagePath = path.resolve(trainingDir, record.image);
    const extraction = extractCaptchaGlyphVectors(imagePath, options);

    for (let index = 0; index < extraction.glyphVectors.length; index += 1) {
      samples.push({
        sampleId: `${record.id}:${index}`,
        captchaId: record.id,
        position: index,
        label: record.text[index],
        vector: extraction.glyphVectors[index],
        glyphMetrics: extraction.glyphMetrics[index],
        segmentationQuality: extraction.segmentation.segmentationQuality,
      });
    }
  }

  return samples;
}

/**
 * 作用：
 * 用指定模型评估一组 captcha 记录。
 *
 * 为什么这样写：
 * 第一版训练脚本的价值不只是产出模型，还要明确知道在 train/val/test 上到底表现到哪里。
 *
 * 输入：
 * @param {Array<object>} records - 待评估记录数组。
 * @param {string} trainingDir - 训练目录绝对路径。
 * @param {object} model - 原型模型。
 * @param {object} options - 预处理配置。
 *
 * 输出：
 * @returns {object} 评估摘要和逐条预测列表。
 *
 * 注意：
 * - 会同时输出字符级和整串级准确率。
 * - 当前不做混淆矩阵，先保持报告简洁。
 */
function evaluateCaptchaRecords(records, trainingDir, model, options) {
  const predictions = [];
  let exactMatchCount = 0;
  let characterMatchCount = 0;
  let characterTotalCount = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const imagePath = path.resolve(trainingDir, record.image);
    const extraction = extractCaptchaGlyphVectors(imagePath, options);
    const prediction = predictCaptchaText(extraction.glyphVectors, model);
    const expected = String(record.text || "");

    if (prediction.text === expected) {
      exactMatchCount += 1;
    }

    for (let index = 0; index < expected.length; index += 1) {
      if (prediction.characters[index] === expected[index]) {
        characterMatchCount += 1;
      }

      characterTotalCount += 1;
    }

    predictions.push({
      id: record.id,
      split: record.split,
      expectedText: expected,
      predictedText: prediction.text,
      exactMatch: prediction.text === expected,
      characters: prediction.characters,
      distances: prediction.distances,
      topK: prediction.topK,
      confidence: prediction.confidence,
      segmentationQuality: extraction.segmentation.segmentationQuality,
      segmentationMethod: extraction.segmentation.selectedMethod,
      segmentationScore: extraction.segmentation.segmentationScore,
      glyphMetrics: extraction.glyphMetrics,
      image: record.image,
    });
  }

  return {
    recordCount: predictions.length,
    exactMatchCount,
    exactMatchRate:
      predictions.length > 0 ? Number((exactMatchCount / predictions.length).toFixed(4)) : 0,
    characterMatchCount,
    characterTotalCount,
    characterAccuracy:
      characterTotalCount > 0
        ? Number((characterMatchCount / characterTotalCount).toFixed(4))
        : 0,
    predictions,
  };
}

/**
 * 作用：
 * 统计预测结果里按字符位置划分的准确率。
 *
 * 为什么这样写：
 * 当前数据已经表明第 1 位和第 4 位比中间两位更难。
 * 把位置指标单独拉出来，后续才能判断分割升级是否真的起作用。
 *
 * 输入：
 * @param {Array<object>} predictions - 逐条 captcha 预测结果。
 *
 * 输出：
 * @returns {Array<object>} 每个字符位置的准确率摘要。
 *
 * 注意：
 * - 当前固定按 4 位 captcha 统计。
 * - 若未来长度变化，需要同步调整这里的循环上限。
 */
function buildPositionMetrics(predictions) {
  const totals = [0, 0, 0, 0];
  const correct = [0, 0, 0, 0];

  for (const row of Array.isArray(predictions) ? predictions : []) {
    const expected = String(row.expectedText || "");
    const actual = Array.isArray(row.characters) ? row.characters : [];

    for (let index = 0; index < Math.min(4, expected.length, actual.length); index += 1) {
      totals[index] += 1;

      if (expected[index] === actual[index]) {
        correct[index] += 1;
      }
    }
  }

  return totals.map((total, index) => ({
    position: index,
    total,
    correct: correct[index],
    accuracy: total > 0 ? Number((correct[index] / total).toFixed(4)) : 0,
  }));
}

/**
 * 作用：
 * 聚合预测结果中的字符混淆对。
 *
 * 为什么这样写：
 * 当前精度提升最需要的不是更多总数，而是知道最常错的是哪些 pair。
 * 把混淆对聚合出来后，后续补数和特征迭代都能更有针对性。
 *
 * 输入：
 * @param {Array<object>} predictions - 逐条 captcha 预测结果。
 * @param {number} limit - 最多返回多少条。
 *
 * 输出：
 * @returns {Array<object>} 按出现次数排序的混淆摘要。
 *
 * 注意：
 * - 只统计错位字符，不统计整串是否命中。
 * - 默认输出前 20 条。
 */
function buildConfusionSummary(predictions, limit = 20) {
  const counter = new Map();

  for (const row of Array.isArray(predictions) ? predictions : []) {
    const expected = String(row.expectedText || "");
    const actual = Array.isArray(row.characters) ? row.characters : [];

    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      if (expected[index] === actual[index]) {
        continue;
      }

      const key = `${expected[index]}->${actual[index]}`;
      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }

  return Array.from(counter.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(1, limit))
    .map(([pair, count]) => ({
      pair,
      count,
    }));
}

/**
 * 作用：
 * 汇总训练字符覆盖到哪些业务类别。
 *
 * 为什么这样写：
 * 用户希望把数据补到 400-500 张，但不是盲补。
 * 先按 digits / uppercase / lowercase / symbols 聚合覆盖，才能看出下一轮该补哪类。
 *
 * 输入：
 * @param {object} prototypeCounts - 每个字符的训练样本数。
 *
 * 输出：
 * @returns {object} 聚合后的类别覆盖统计。
 *
 * 注意：
 * - 当前把 `@ # + =` 归为 symbols。
 * - 这里只统计训练覆盖，不代表识别效果。
 */
function buildCharacterCategoryCoverage(prototypeCounts) {
  const summary = {
    digits: 0,
    uppercase: 0,
    lowercase: 0,
    symbols: 0,
  };

  for (const [label, count] of Object.entries(prototypeCounts || {})) {
    if (/^[0-9]$/u.test(label)) {
      summary.digits += count;
    } else if (/^[A-Z]$/u.test(label)) {
      summary.uppercase += count;
    } else if (/^[a-z]$/u.test(label)) {
      summary.lowercase += count;
    } else {
      summary.symbols += count;
    }
  }

  return summary;
}

/**
 * 作用：
 * 汇总符号字符相关的错误率。
 *
 * 为什么这样写：
 * `#`、`=`、`+`、`@` 是当前 hardest cases 的一部分。
 * 单独看符号错误率，能帮助判断衬线特征是否真的对符号识别有帮助。
 *
 * 输入：
 * @param {Array<object>} predictions - 逐条 captcha 预测结果。
 *
 * 输出：
 * @returns {object} 符号相关错误统计。
 *
 * 注意：
 * - 只统计期待字符是符号的位点。
 * - 当前符号集合固定为 `@ # + =`。
 */
function buildSymbolErrorSummary(predictions) {
  const symbolSet = new Set(["@", "#", "+", "="]);
  let total = 0;
  let errors = 0;

  for (const row of Array.isArray(predictions) ? predictions : []) {
    const expected = String(row.expectedText || "");
    const actual = Array.isArray(row.characters) ? row.characters : [];

    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      if (!symbolSet.has(expected[index])) {
        continue;
      }

      total += 1;

      if (expected[index] !== actual[index]) {
        errors += 1;
      }
    }
  }

  return {
    total,
    errors,
    errorRate: total > 0 ? Number((errors / total).toFixed(4)) : 0,
  };
}

/**
 * 作用：
 * 汇总“衬线体 hard cases”相关混淆。
 *
 * 为什么这样写：
 * 用户已经明确指出这些 captcha 看起来像衬线体英文。
 * 因此分析报告必须单独告诉我们：大小写、符号、形近字符组到底错在哪些 pair 上。
 *
 * 输入：
 * @param {Array<object>} predictions - 逐条 captcha 预测结果。
 * @param {number} limit - 最多返回多少条摘要。
 *
 * 输出：
 * @returns {Array<object>} 按出现次数排序的衬线 hard-case 混淆摘要。
 *
 * 注意：
 * - 当前规则覆盖三类：大小写同字母、符号/字母数字、预定义结构相近组。
 * - 这是分析启发式，不是业务真值。
 */
function buildSerifConfusionSummary(predictions, limit = 20) {
  const structuralGroups = [
    new Set(["C", "c"]),
    new Set(["P", "p"]),
    new Set(["K", "k"]),
    new Set(["S", "s"]),
    new Set(["#", "H"]),
    new Set(["=", "t"]),
    new Set(["7", "+"]),
    new Set(["@", "a", "q"]),
  ];
  const counter = new Map();

  function isSerifHardCase(expected, actual) {
    if (expected === actual) {
      return false;
    }

    if (expected.toLowerCase() === actual.toLowerCase()) {
      return true;
    }

    if (/[@#+=]/u.test(expected) || /[@#+=]/u.test(actual)) {
      return true;
    }

    return structuralGroups.some((group) => group.has(expected) && group.has(actual));
  }

  for (const row of Array.isArray(predictions) ? predictions : []) {
    const expected = String(row.expectedText || "");
    const actual = Array.isArray(row.characters) ? row.characters : [];

    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      if (!isSerifHardCase(expected[index], actual[index])) {
        continue;
      }

      const key = `${expected[index]}->${actual[index]}`;
      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }

  return Array.from(counter.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(1, limit))
    .map(([pair, count]) => ({
      pair,
      count,
    }));
}

/**
 * 作用：
 * 根据 holdout 单次命中率估算 5 次 fresh captcha 内的成功率。
 *
 * 为什么这样写：
 * 用户真正关心的是“5 次内能不能过”，而不是单次 exact match 数字本身。
 * 用独立近似先给一个离线代理指标，后续再拿 live benchmark 校正。
 *
 * 输入：
 * @param {Array<object>} predictions - holdout 预测列表。
 * @param {number} maxAttempts - 最大 fresh captcha 次数。
 *
 * 输出：
 * @returns {object} 单次与 5 次累计命中率估算。
 *
 * 注意：
 * - 这里假设不同 fresh captcha 尝试近似独立。
 * - 这只是离线估算，不等价于真实站点最终成功率。
 */
function buildFiveAttemptSuccessEstimate(predictions, maxAttempts = 5) {
  const rows = Array.isArray(predictions) ? predictions : [];
  const exactMatchCount = rows.filter((row) => row && row.exactMatch === true).length;
  const singleAttemptRate = rows.length > 0 ? exactMatchCount / rows.length : 0;
  const successWithinBudget = 1 - (1 - singleAttemptRate) ** Math.max(1, Number(maxAttempts || 5));

  return {
    maxAttempts: Math.max(1, Number(maxAttempts || 5)),
    sampleCount: rows.length,
    exactMatchCount,
    singleAttemptExactMatchRate: Number(singleAttemptRate.toFixed(4)),
    estimatedSuccessWithinBudget: Number(successWithinBudget.toFixed(4)),
  };
}

/**
 * 作用：
 * 训练并写出当前本地 captcha 原型模型。
 *
 * 为什么这样写：
 * 用户已经花时间把 206 张图标完，这一步要尽快把人工数据变成可复用的本地模型和报告。
 *
 * 输入：
 * @param {string} trainingDir - 训练数据目录。
 * @param {string} outputDir - 模型输出目录。
 * @param {object} options - 训练与预处理选项。
 *
 * 输出：
 * @returns {object} 训练摘要。
 *
 * 注意：
 * - 会清空并重建目标模型目录。
 * - 当前第一版模型是字符原型平均值，不是深度学习模型。
 */
function trainLocalCaptchaModel(trainingDir, outputDir, options = {}) {
  const resolvedTrainingDir = path.resolve(trainingDir);
  const allRecords = readJsonLines(path.join(resolvedTrainingDir, "all.jsonl"));
  const trainRecords = allRecords.filter((record) => record.split === "train");
  const valRecords = allRecords.filter((record) => record.split === "val");
  const testRecords = allRecords.filter((record) => record.split === "test");
  const characterSamples = buildCharacterSamples(trainRecords, resolvedTrainingDir, options);
  const globalPrototypeModel = buildPrototypeModel(characterSamples);
  const exemplarLimit = Math.max(6, Number(options.exemplarLimit || 10));
  const clusterCount = Math.max(2, Number(options.clusterCount || 3));
  const model = {
    labels: globalPrototypeModel.labels,
    prototypes: globalPrototypeModel.prototypes,
    positionExemplars: buildPositionAwareExemplarIndex(characterSamples, exemplarLimit),
    positionPrototypes: buildPositionAwarePrototypeIndex(characterSamples, clusterCount),
  };
  const resolvedOutputDir = path.resolve(outputDir);

  fs.rmSync(resolvedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const trainEvaluation = evaluateCaptchaRecords(trainRecords, resolvedTrainingDir, model, options);
  const valEvaluation = evaluateCaptchaRecords(valRecords, resolvedTrainingDir, model, options);
  const testEvaluation = evaluateCaptchaRecords(testRecords, resolvedTrainingDir, model, options);
  const holdoutPredictions = [...valEvaluation.predictions, ...testEvaluation.predictions];
  const prototypeCounts = Object.fromEntries(
    model.labels.map((label) => [label, model.prototypes[label].count])
  );
  const summary = {
    trainingDir: resolvedTrainingDir,
    outputDir: resolvedOutputDir,
    vectorWidth: Number(options.vectorWidth || 18),
    vectorHeight: Number(options.vectorHeight || 22),
    exemplarLimit,
    clusterCount,
    trainCaptchaCount: trainRecords.length,
    valCaptchaCount: valRecords.length,
    testCaptchaCount: testRecords.length,
    prototypeLabelCount: model.labels.length,
    prototypeCounts,
    characterCategoryCoverage: buildCharacterCategoryCoverage(prototypeCounts),
    positionMetrics: buildPositionMetrics(holdoutPredictions),
    confusionSummary: buildConfusionSummary(holdoutPredictions, 20),
    serifConfusionSummary: buildSerifConfusionSummary(holdoutPredictions, 20),
    symbolErrorSummary: buildSymbolErrorSummary(holdoutPredictions),
    fiveAttemptSuccessEstimate: buildFiveAttemptSuccessEstimate(holdoutPredictions, 5),
    metrics: {
      train: {
        recordCount: trainEvaluation.recordCount,
        exactMatchRate: trainEvaluation.exactMatchRate,
        characterAccuracy: trainEvaluation.characterAccuracy,
      },
      val: {
        recordCount: valEvaluation.recordCount,
        exactMatchRate: valEvaluation.exactMatchRate,
        characterAccuracy: valEvaluation.characterAccuracy,
      },
      test: {
        recordCount: testEvaluation.recordCount,
        exactMatchRate: testEvaluation.exactMatchRate,
        characterAccuracy: testEvaluation.characterAccuracy,
      },
    },
  };

  fs.writeFileSync(
    path.join(resolvedOutputDir, "model.json"),
    `${JSON.stringify(
      {
        metadata: {
          vectorWidth: summary.vectorWidth,
          vectorHeight: summary.vectorHeight,
          labelCount: summary.prototypeLabelCount,
          featureSchema: {
            occupancyGrid: {
              width: summary.vectorWidth,
              height: summary.vectorHeight,
              weight: 0.7,
            },
            projections: {
              rowWeight: 1.05,
              columnWeight: 1.05,
            },
            transitions: {
              rowWeight: 1,
              columnWeight: 1,
            },
            serifSensitiveProfiles: {
              topWeight: 1.2,
              bottomWeight: 1.2,
              leftWeight: 1.15,
              rightWeight: 1.15,
            },
            scalarFeatures: [
              "ink_density",
              "aspect_ratio",
              "center_x",
              "center_y",
            ],
          },
          exemplarLimit,
          clusterCount,
          classifierWeights: {
            exemplar: 0.15,
            positionPrototype: 0.25,
            globalPrototype: 0.6,
          },
        },
        model,
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(resolvedOutputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(resolvedOutputDir, "train-predictions.json"),
    `${JSON.stringify(trainEvaluation.predictions, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(resolvedOutputDir, "val-predictions.json"),
    `${JSON.stringify(valEvaluation.predictions, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(resolvedOutputDir, "test-predictions.json"),
    `${JSON.stringify(testEvaluation.predictions, null, 2)}\n`
  );

  return summary;
}

/**
 * 作用：
 * 解析本地训练脚本的命令行参数。
 *
 * 为什么这样写：
 * 训练脚本当前只需要最小参数面，保持简单更方便高频调参和重复运行。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数数组。
 *
 * 输出：
 * @returns {object} 解析后的训练参数。
 *
 * 注意：
 * - `--dataset` 复用训练准备阶段的 manifest 入口。
 * - `--vector-width` 和 `--vector-height` 只接受正整数。
 * - `--cluster-count` 和 `--exemplar-limit` 用于控制多原型模型规模。
 */
function parseLocalTrainArgs(argv) {
  const trainingOptions = parseTrainingArgs(argv);
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: trainingOptions.datasetInput,
    vectorWidth: 18,
    vectorHeight: 22,
    clusterCount: 3,
    exemplarLimit: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--vector-width") {
      options.vectorWidth = Number.parseInt(String(args[index + 1] || "18"), 10) || 18;
      index += 1;
    } else if (arg === "--vector-height") {
      options.vectorHeight = Number.parseInt(String(args[index + 1] || "22"), 10) || 22;
      index += 1;
    } else if (arg === "--cluster-count") {
      options.clusterCount = Number.parseInt(String(args[index + 1] || "3"), 10) || 3;
      index += 1;
    } else if (arg === "--exemplar-limit") {
      options.exemplarLimit = Number.parseInt(String(args[index + 1] || "10"), 10) || 10;
      index += 1;
    }
  }

  return options;
}

/**
 * 作用：
 * 为本地训练入口解析默认使用的主标注清单路径。
 *
 * 为什么这样写：
 * 训练现在应该优先消费 `data/` 中的主标注库。
 * 但为了兼容尚未完全迁移的工作区，这里仍保留对旧 `artifacts/` 清单的最后兜底。
 *
 * 输入：
 * @param {string} dataDir - data 根目录。
 * @param {string} artifactsDir - artifacts 根目录。
 *
 * 输出：
 * @returns {string} 默认标注清单路径。
 *
 * 注意：
 * - 优先级是 `data` 主清单优先，`artifacts` 旧清单兜底。
 * - 这里只返回路径，不校验标签内容是否可训练。
 */
function resolvePreferredTrainingManifestPath(dataDir, artifactsDir) {
  const dataManifestPath = path.join(path.resolve(dataDir), "captcha-images-current-labels.json");

  if (fs.existsSync(dataManifestPath)) {
    return dataManifestPath;
  }

  return path.join(path.resolve(artifactsDir), "captcha-images-current-labels.json");
}

/**
 * 作用：
 * 运行第一版本地训练命令。
 *
 * 为什么这样写：
 * 这是“标注完成之后”的第一版闭环：
 * 先准备训练目录，再训练原型模型，再输出评估结果。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 默认使用 `data/captcha-images-current-labels.json`。
 * - 会重建 `data/captcha-training-current` 和 `model/captcha-model-current`。
 */
function main(argv) {
  const options = parseLocalTrainArgs(argv);
  const dataDir = getDataDir();
  const artifactsDir = getArtifactsDir();
  const manifestPath =
    options.datasetInput || resolvePreferredTrainingManifestPath(dataDir, artifactsDir);
  const trainingSummary = prepareTrainingDataset(manifestPath, getCurrentTrainingDir());
  const trainingDir = getCurrentTrainingDir();
  const modelSummary = trainLocalCaptchaModel(
    trainingDir,
    getCurrentCaptchaModelDir(),
    {
      vectorWidth: options.vectorWidth,
      vectorHeight: options.vectorHeight,
      clusterCount: options.clusterCount,
      exemplarLimit: options.exemplarLimit,
    }
  );

  console.log(
    JSON.stringify(
      {
        trainingSummary,
        modelSummary,
      },
      null,
      2
    )
  );
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
  buildCharacterCategoryCoverage,
  buildCharacterSamples,
  buildColumnProjection,
  buildConfusionSummary,
  buildEdgeDistanceProfile,
  buildEqualWidthGlyphBoundaries,
  buildFiveAttemptSuccessEstimate,
  buildGrayscalePixels,
  buildPrototypeModel,
  buildPositionAwareExemplarIndex,
  buildPositionAwarePrototypeIndex,
  buildPositionMetrics,
  buildRowProjection,
  buildSerifConfusionSummary,
  buildSymbolErrorSummary,
  buildTransitionFeatures,
  chooseGlyphBoundaries,
  computeOtsuThreshold,
  computeForegroundCenterOfMass,
  computeForegroundDensity,
  createInitialBinaryMask,
  decodePng,
  denoiseBinaryMask,
  extractCaptchaGlyphVectorsFromDataUrl,
  extractCaptchaGlyphVectorsFromDecodedImage,
  extractGlyphFeatureVector,
  evaluateCaptchaRecords,
  expandBounds,
  extractCaptchaGlyphVectors,
  extractGlyphBounds,
  findConnectedComponents,
  findMaskBounds,
  loadLocalCaptchaModel,
  parseLocalTrainArgs,
  parseImageDataUrl,
  paethPredictor,
  predictCaptchaDataUrl,
  predictCaptchaImagePath,
  predictCaptchaText,
  predictCharacterVector,
  readJsonLines,
  resampleNumericSequence,
  scoreCharacterLabel,
  scoreGlyphSegmentation,
  selectBestGlyphSegmentation,
  selectRepresentativeExemplars,
  squaredDistance,
  trainLocalCaptchaModel,
  unfilterPngScanlines,
  vectorizeMaskRegion,
};
