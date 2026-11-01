/** 运行时资产生成绝对 URL，兼容 Vite dev（http）和 Electron 打包后的 file://。 */
export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export async function installBundledFonts(): Promise<void> {
  try {
    const font = new FontFace(
      'KenneyFuture',
      `url(${assetUrl('assets/ui/fonts/KenneyFuture.ttf')})`,
    );
    await font.load();
    document.fonts.add(font);
  } catch {
    // 字体失败不影响功能，CSS 会回退到系统字体。
  }
}
