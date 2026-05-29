// wrangler [[rules]] type="Text" 文本模块声明
declare module '*.html' {
  const content: string;
  export default content;
}
