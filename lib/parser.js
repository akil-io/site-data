function getParser(document) {
  return class Parser {
    constructor(mapper) {
      this._data = {};

      this._get = {
        string: (item) => ("" + (item.innerText || item.text || item.textContent)).trim(),
        href: (item) => item.href,
        number: (item) => parseInt(this._get.string(item)),
        text: (item) => [...item.childNodes].filter(n => n.nodeType == document.TEXT_NODE).map(v => v.textContent).join(" ").trim(),
        image: (item) => item.src,
        attr: (item, name) => item.attributes[name].value,

        value: (item, type, query, name) => this._get[type](query ? item.querySelector(query) : item, name),
        list: (item, type, query, name) => [...(query ? item.querySelectorAll(query) : item).values()].map(i => this._get[type](i, name)),
        dict: (item, type, query, keyQuery, valueQuery) => [...item.querySelectorAll(query).values()].map(i => Parser.data([i], {
          key: ["string", keyQuery],
          value: [type, valueQuery]
        }).pop()).reduce((acc, cur) => {
          acc[cur.key.replace(/\:/ig, "")] = cur.value;
          return acc;
        }, {}),
        object: (item, options) => Parser.data([item], options).pop(),
        collection: (item, query, options) => Parser.data([...item.querySelectorAll(query).values()], options)
      };

      this._mapper = Object.keys(mapper).reduce((acc, cur) => {
        acc[cur] = this.buildMapperItem(mapper[cur]);
        return acc;
      }, {});
    }

    buildMapperItem(options) {
      if (options.constructor.name === "Object") {
        return (item) => this._get.object(item, options);
      } else if (options.constructor.name === "Array" && options[1].constructor.name === "Object") {
        return (item) => this._get.collection(item, options[0], options[1]);
      } else {
        const type = (["value", "list", "dict"].indexOf(options[0]) === -1) ? "value" : options[0];
        const attrs = ((["value", "list", "dict"].indexOf(options[0]) === -1) ? options : options.slice(1)).map(i => JSON.stringify(i)).join(", ");

        return eval(`(item) => this._get.${type}(item, ${attrs})`);
      }
    }

    fill(item) {
      return Object.keys(this._mapper).reduce((acc, cur) => { acc[cur] = this._mapper[cur](item); return acc; }, {});
    }
    grab(items) {
      return items.map(item => this.fill(item));
    }

    static data(items, mapper) {
      let p = new Parser(mapper);
      return p.grab((items.constructor.name === "String") ? [...document.querySelectorAll(items).values()] : items);
    }
  }
};

if (module) {
  module.exports = { getParser };
}
if (window) {
  (() => {window.Parser = getParser(window.document)})();
}