const h = new Proxy(function () {}, {
  get: (_t, k) => (k === "__esModule" ? true : (k === "default" ? h : h)),
  set: () => true, has: () => true, apply: () => h, construct: () => ({}),
});
module.exports = h;
