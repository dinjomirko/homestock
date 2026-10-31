// Decodes barcodes off the main thread so the camera preview stays smooth.
// Receives a grayscale crop of the camera frame and tries it upright, then turned 90°
// so barcodes printed vertically on a box read too. Only 1D retail formats are enabled,
// which is several times faster than also searching for QR codes.
importScripts('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');

const Z = self.ZXing;
const F = Z.BarcodeFormat;
const hints = new Map([
  [Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.UPC_A, F.EAN_8, F.UPC_E, F.CODE_128, F.CODE_39]],
  [Z.DecodeHintType.TRY_HARDER, true],
]);
const reader = new Z.MultiFormatOneDReader(hints);

function decode(lum, w, h) {
  try {
    const src = new Z.PlanarYUVLuminanceSource(lum, w, h, 0, 0, w, h, false);
    const r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(src)), hints);
    return { text: r.getText(), format: F[r.getBarcodeFormat()] };
  } catch {
    return null;
  } finally {
    reader.reset();
  }
}

function rotate(lum, w, h) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = lum[row + x];
  }
  return out;
}

self.onmessage = ({ data: { lum, w, h } }) => {
  const hit = decode(lum, w, h) || decode(rotate(lum, w, h), h, w);
  self.postMessage(hit);
};

self.postMessage({ ready: true });
