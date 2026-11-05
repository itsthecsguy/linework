declare module 'subset-font' {
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: { targetFormat?: 'woff2' | 'woff' | 'truetype' | 'sfnt'; preserveNameIds?: number[]; variationAxes?: Record<string, number> },
  ): Promise<Buffer>;
}
