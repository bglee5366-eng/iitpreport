declare module "pdfkit" {
  interface PDFDocumentOptions {
    size?: string;
    margin?: number;
  }

  type TextOptions = {
    paragraphGap?: number;
    lineGap?: number;
  };

  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    font(src: string | Buffer): this;
    fontSize(size: number): this;
    text(text: string, options?: TextOptions): this;
    on(event: string, listener: (...args: any[]) => void): this;
    end(): void;
  }

  export default PDFDocument;
}
