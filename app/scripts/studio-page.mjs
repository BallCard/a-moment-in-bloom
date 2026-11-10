/** Run the same browser assertions inside ModelScope's public application frame. */
export async function newStudioAwarePage(context) {
  const outer = await context.newPage();
  let embedded = false;
  const frame = () => embedded
    ? outer.frames().find(item => item.url().startsWith('https://ballcard-bouquet-workbench.ms.show/'))
    : outer.mainFrame();
  async function ready() {
    if (!embedded) return;
    await outer.waitForEvent('framenavigated', {
      predicate: item => item.url().startsWith('https://ballcard-bouquet-workbench.ms.show/'),
      timeout: 60000,
    }).catch(error => { if (!frame()) throw error; });
    await frame().waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest' || document.querySelector('[data-testid="start-continue"]'));
  }
  const scoped = new Set(['evaluate','getByRole','getByTestId','locator','waitForFunction','waitForSelector']);
  return new Proxy(outer, { get(target, property) {
    if (property === 'goto') return async (url, options) => {
      embedded = url.includes('modelscope.cn/studios/');
      const response = await outer.goto(url, options);
      if (embedded && !frame()) await ready();
      else if (embedded) await frame().waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest' || document.querySelector('[data-testid="start-continue"]'));
      return response;
    };
    // Reload only the app, preserving the surrounding platform session.
    if (property === 'reload' && embedded) return async () => {
      await frame().evaluate(() => location.reload());
      await frame().waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest' || document.querySelector('[data-testid="start-continue"]'));
    };
    if (scoped.has(property)) return (...args) => frame()[property](...args);
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
