// Node.js 25 built-in localStorage has methods as undefined when invoked without --localstorage-file.
type LocalStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
  length: number;
};

type GlobalWithLocalStorage = typeof globalThis & {
  localStorage?: Partial<LocalStorageLike>;
};

const g = globalThis as GlobalWithLocalStorage;

if (typeof globalThis !== "undefined" && typeof g.localStorage !== "undefined") {
  const ls = g.localStorage;
  if (!ls || typeof ls.getItem !== "function") {
    const noop = () => null;
    g.localStorage = {
      getItem:    noop,
      setItem:    noop,
      removeItem: noop,
      clear:      noop,
      key:        noop,
      length:     0,
    };
  }
}

export async function register() {}
