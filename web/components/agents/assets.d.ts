declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.png" {
  const image: import("next/image").StaticImageData;
  export default image;
}
