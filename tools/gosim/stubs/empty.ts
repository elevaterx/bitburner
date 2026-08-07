const h: any = new Proxy(function () {} as any, {
  get: (_t, k) => (k === "__esModule" ? true : h),
  apply: () => h, construct: () => ({}),
});
export default h;
export const __empty = true;
