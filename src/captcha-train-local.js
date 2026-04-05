const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const zlib = require("node:zlib");

const {
  prepareTrainingDataset,
  parseTrainingArgs,
} = require("./captcha-training");

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
  const bounds = expandBounds(
    findMaskBounds(mask, image.width, image.height) || initialMaskResult.cropBox,
    image.width,
    image.height,
    1
  );
  const projection = buildColumnProjection(mask, image.width, bounds);
  const boundaries = chooseGlyphBoundaries(projection);
  const glyphVectors = [];

  for (let index = 0; index < 4; index += 1) {
    const glyphBounds = extractGlyphBounds(
      mask,
      image.width,
      image.height,
      bounds,
      boundaries[index],
      boundaries[index + 1]
    );

    glyphVectors.push(
      vectorizeMaskRegion(mask, image.width, glyphBounds, vectorWidth, vectorHeight)
    );
  }

  return {
    glyphVectors,
    threshold: initialMaskResult.threshold,
    bounds,
    boundaries,
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
 * 用字符原型模型预测单个字符向量。
 *
 * 为什么这样写：
 * 训练和评估阶段都需要统一的最近邻打分逻辑。
 *
 * 输入：
 * @param {number[]} vector - 待预测字符向量。
 * @param {object} model - 原型模型。
 *
 * 输出：
 * @returns {object} 最佳标签和距离。
 *
 * 注意：
 * - 当前只返回最优字符，不返回 top-k。
 * - 如果模型为空会直接抛错。
 */
function predictCharacterVector(vector, model) {
  const labels = Array.isArray(model && model.labels) ? model.labels : [];

  if (labels.length === 0) {
    throw new Error("Prototype model is empty.");
  }

  let bestLabel = labels[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const label of labels) {
    const prototype = model.prototypes[label];
    const distance = squaredDistance(vector, prototype.vector);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestLabel = label;
    }
  }

  return {
    label: bestLabel,
    distance: Number(bestDistance.toFixed(6)),
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
  const predictions = glyphVectors.map((vector) => predictCharacterVector(vector, model));

  return {
    text: predictions.map((prediction) => prediction.label).join(""),
    characters: predictions.map((prediction) => prediction.label),
    distances: predictions.map((prediction) => prediction.distance),
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
    threshold: extraction.threshold,
    bounds: extraction.bounds,
    boundaries: extraction.boundaries,
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
  const model = buildPrototypeModel(characterSamples);
  const resolvedOutputDir = path.resolve(outputDir);

  fs.rmSync(resolvedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const trainEvaluation = evaluateCaptchaRecords(trainRecords, resolvedTrainingDir, model, options);
  const valEvaluation = evaluateCaptchaRecords(valRecords, resolvedTrainingDir, model, options);
  const testEvaluation = evaluateCaptchaRecords(testRecords, resolvedTrainingDir, model, options);
  const summary = {
    trainingDir: resolvedTrainingDir,
    outputDir: resolvedOutputDir,
    vectorWidth: Number(options.vectorWidth || 18),
    vectorHeight: Number(options.vectorHeight || 22),
    trainCaptchaCount: trainRecords.length,
    valCaptchaCount: valRecords.length,
    testCaptchaCount: testRecords.length,
    prototypeLabelCount: model.labels.length,
    prototypeCounts: Object.fromEntries(
      model.labels.map((label) => [label, model.prototypes[label].count])
    ),
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
 */
function parseLocalTrainArgs(argv) {
  const trainingOptions = parseTrainingArgs(argv);
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: trainingOptions.datasetInput,
    vectorWidth: 18,
    vectorHeight: 22,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--vector-width") {
      options.vectorWidth = Number.parseInt(String(args[index + 1] || "18"), 10) || 18;
      index += 1;
    } else if (arg === "--vector-height") {
      options.vectorHeight = Number.parseInt(String(args[index + 1] || "22"), 10) || 22;
      index += 1;
    }
  }

  return options;
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
 * - 默认使用 `artifacts/captcha-images-current-labels.json`。
 * - 会重建 `artifacts/captcha-training-current` 和 `artifacts/captcha-model-current`。
 */
function main(argv) {
  const options = parseLocalTrainArgs(argv);
  const artifactsDir = path.resolve(process.cwd(), "artifacts");
  const manifestPath =
    options.datasetInput || path.join(artifactsDir, "captcha-images-current-labels.json");
  const trainingSummary = prepareTrainingDataset(
    manifestPath,
    path.join(artifactsDir, "captcha-training-current")
  );
  const trainingDir = path.join(artifactsDir, "captcha-training-current");
  const modelSummary = trainLocalCaptchaModel(
    trainingDir,
    path.join(artifactsDir, "captcha-model-current"),
    {
      vectorWidth: options.vectorWidth,
      vectorHeight: options.vectorHeight,
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
  buildCharacterSamples,
  buildColumnProjection,
  buildGrayscalePixels,
  buildPrototypeModel,
  chooseGlyphBoundaries,
  computeOtsuThreshold,
  createInitialBinaryMask,
  decodePng,
  denoiseBinaryMask,
  extractCaptchaGlyphVectorsFromDataUrl,
  extractCaptchaGlyphVectorsFromDecodedImage,
  evaluateCaptchaRecords,
  expandBounds,
  extractCaptchaGlyphVectors,
  extractGlyphBounds,
  findMaskBounds,
  loadLocalCaptchaModel,
  parseLocalTrainArgs,
  parseImageDataUrl,
  paethPredictor,
  predictCaptchaDataUrl,
  predictCaptchaText,
  predictCharacterVector,
  readJsonLines,
  squaredDistance,
  trainLocalCaptchaModel,
  unfilterPngScanlines,
  vectorizeMaskRegion,
};
