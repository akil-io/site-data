const request = require('request');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const { getParser } = require("./parser");
const iconv = require('iconv-lite');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

class Loader {
	constructor(mainPage, options) {
		this._site = new URL(mainPage);
		this._domain = (new URL(mainPage)).hostname;

		this._options = Object.assign({}, {
			encoding: 'utf-8',
			timeout: 15000,
			debug: false,
			outputPath: path.join(process.cwd(), this._domain)
		}, options);
		if (options.outputPath) this._options.outputPath = path.resolve(this._options.outputPath);

		this._cachePath = path.join(this._options.outputPath, '.cache');
		this._indexPath = path.join(this._options.outputPath, '.cache', 'index.json');
		this._pagesPath = path.join(this._options.outputPath, '.cache', 'pages.json');

		this._stat = {
			request: 0,
			file: 0,
			cache: 0,
			parsed: 0
		};
	}

	_debug(msg, data) {
		if (this._options.debug) {
			console.log(msg, data ? util.inspect(data, {depth:null,colors:true}) : "");
		}
	}

	handleUrl(_url, lastErr = null) {
		try {
			return new URL(_url);
		} catch (err) {
			if (lastErr) {
				return null;
			}
			if (_url.substr(0, 2) === "//") {
				//this._debug('- FIX URL (no protocol)', _url);
				return this.handleUrl(this._site.protocol + _url, err);
			}
			if (_url.indexOf(this._site.host) !== -1) {
				//this._debug('- FIX URL (no protocol and slashes)', _url);
				return this.handleUrl(this._site.protocol + '//' + _url, err);
			}
			if (_url.indexOf(this._site.host) === -1 && _url.substr(0, 1) === "/") {
				//this._debug('- FIX URL (no origin)', _url);
				return this.handleUrl(this._site.origin + _url, err);
			}
			return null;
		}
	}

	request(url) {
		return new Promise((resolve, reject) => {
			request({
				method: "GET",
				uri: url,
				encoding: null,
				headers: this._options.headers || {
					'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:26.0) Gecko/20100101 Firefox/26.0'
				},
				agent: this._options.agent,
				timeout: this._options.timeout
			}, (error, response, body) => {
				if (error || response.statusCode !== 200) {
					this._debug(`- REQUEST ERROR (${response && response.statusCode}): `, error);
					return reject(error);
				}
				this._stat.request++;
				resolve(response);
			});
		});
	}

	async cache(url) {
		const hash = crypto.createHash('sha256');
		let key = hash.update([
			url.pathname,
			url.search
		].join("")).digest('hex');

		let filePath = path.join(this._cachePath, key);
		let pathExists = await fs.pathExists(filePath)
		let index = await fs.readJson(this._indexPath);

		if (pathExists) {
			if (index[key] !== undefined) {
				this._debug(`- CACHE ${key}`, index[key].date);
				return Object.assign({}, index[key], {filePath});
			} else {
				this._debug(`- CLEAR CACHE ${key}`);
				await fs.remove(filePath);
			}
		}
		return {
			filePath,
			key
		};
	}

	async get(url, noCache = false) {
		let urlObject = null;
		if (url instanceof URL) urlObject = url;
		else {
			this._debug('\n\nGET: ', url);
			urlObject = this.handleUrl(url);
		}
		if (!urlObject) {
			this._debug('- BAD URL: ', url);
			return null;
		}
		if (noCache) {
			let response = await this.request(urlObject.href);
			return response.body;
		}

		let cacheObject = await this.cache(urlObject);

		if (!cacheObject.size) {
			this._debug('- NO CACHE: ', urlObject.href);
			let response = null;
			try {
				response = await this.request(urlObject.href);
			} catch (err) {
				return null;
			}

			let contentType = response.headers['content-type'].split(';').map(chunk => chunk.trim());
			let meta = {
				source: urlObject.href,
				size: Buffer.byteLength(response.body, "binary"),
				type: contentType[0],
				charset: (contentType[1]?contentType[1].substr("charset=".length):"binary"),
				date: (new Date()).toString()
			};

			let index = await fs.readJson(this._indexPath);
			await fs.writeFile(cacheObject.filePath, response.body, 'binary');

			index[cacheObject.key] = meta;
			await fs.writeJson(this._indexPath, index, {spaces:2});

			return response.body;
		} else {
			this._debug('- CACHE HIT: ', urlObject.href);
			this._stat.cache++;
			return fs.readFile(cacheObject.filePath);
		}
	}

	async page(type, url, data = {}) {
		let body = await this.get(url);
		if (!body) return null;

		body = iconv.decode(body, this._options.encoding);
		const dom = new JSDOM(body);
		let Parser = getParser(dom.window.document);

		let meta = Parser.data("head", {
			title: ["string", "title"],
			keywords: ["attr", "meta[name=keywords]", "content"],
			description: ["attr", "meta[name=description]", "content"],
			charset: ["attr", "meta[charset]", "charset"]
		}).pop();
		let links = [...(new Set(Parser.data("body", { links: ["list", "attr", "a[href]", "href"] }).pop().links))];
		let images = [...(new Set(Parser.data("body", { images: ["list", "image", "img[src]"] }).pop().images))];
		let resource = Object.assign({}, Parser.data("head", { styles: ["list", "attr", "link[rel=stylesheet]", "href"] }).pop(), Parser.data("html", { scripts: ["list", "attr", "script[src]", "src"] }).pop()); 


		let stat = {};
		let dataResult = Object.keys(data).reduce((acc, cur) => {
			acc[cur] = Parser.data(
				data[cur].query, 
				data[cur].mapper
			);
			stat[cur] = acc[cur].length;
			this._debug(`- EXTRACT ${cur}`, acc[cur].length);
			return acc;
		}, {
			meta,
			links,
			images,
			resource
		});

		let pages = await fs.readJson(this._pagesPath);
		let urlPath = (url instanceof URL) ? [url.pathname, url.search, url, url.hash].join("") : url.replace(this._site.origin, "");

		pages[urlPath] = {
			type,
			stat,
			meta,
			links,
			images,
			resource
		};
		await fs.writeJson(this._pagesPath, pages, {spaces:2});
		this._stat.parsed++;

		return dataResult;
	}

	async file(url, fileName) {
		let filePath = path.resolve(this._options.outputPath, fileName);
		if (await fs.pathExists(filePath)) {
			this._debug('- FILE EXISTS: ', filePath);
			return true;
		} else {
			let body = await this.get(this.handleUrl(url));
			if (!body) {
				return false;
			}

			this._stat.file++;
			await fs.writeFile(filePath, body, 'binary');

			return true;
		}
	}

	json(name, data) {
		return fs.writeJson(path.join(this._options.outputPath, name + ".json"), data, {spaces:2});
	}

	dir(name) {
		let dirPath = path.resolve(this._options.outputPath, name);
		return fs.ensureDir(dirPath).then(() => dirPath);
	}

	getName(uri) {
		return path.basename((new URL(uri)).pathname);
	}

	async dumpItem(type, url, options, name = null) {
		this._debug('\n\nDUMP: ', url);
		let urlObject = this.handleUrl(url);
		if (!name) name = this.getName(urlObject.href);
		let productPath = [type, name].join("_");

		if (await fs.pathExists(path.join(this._options.outputPath, productPath))) {
			this._stat.cache++;
			return await fs.readJson(path.join(this._options.outputPath, productPath, 'meta.json'));
		}

		try {
			let itemPage = await this.page(type, urlObject, {
				itemData: {
					query: options.query,
					mapper: options.mapper
				}
			});
			if (!itemPage) return null;

			let itemData = itemPage.itemData.pop();
			if (options.values) {
				itemData = options.values(itemData);
			}
			
			await this.dir(productPath);
			let imagesPath = path.join(productPath, 'images');
			await this.dir(imagesPath);

			let images = options.images ? [...(new Set(options.images(itemData).map(img => {
				let imgUrl = this.handleUrl(img.url);
				return {
					url:[imgUrl.origin, imgUrl.pathname].join(""),
					prefix: img.tag
				};
			})))] : [];
			let imagesList = [];
			let imageIndex = 1;

			for (let imageItem of images) {
				let imageUrl = imageItem.url;
				let imageName = [imageItem.prefix, imageIndex + path.extname(this.getName(imageUrl))].join("_");
				let imagePath = path.join(imagesPath, imageName);

				if (await this.file(imageUrl, imagePath)) {
					imageIndex++;
					imagesList.push({
						local: imageName,
						source: imageUrl,
						category: imageItem.prefix
					});
					this._debug(`- SAVE IMAGE: ${imageName}`);
				} else {
					this._debug(`- FAIL TO SAVE IMAGE: ${imageUrl}`);
				}
			}

			let itemMetaData = Object.assign({}, itemData, {
				images: imagesList,
				meta: itemPage.meta
			});
			await this.json(path.join(productPath, 'meta'), itemMetaData);

			return itemMetaData;
		} catch(err) {
			return null;
		}
	}

	async prepareOutput() {
		await this.dir("");
		await this.dir('.cache');
		if (!(await fs.pathExists(this._indexPath))) {
			await this.json(path.join('.cache', 'index'), {});
		}
		if (!(await fs.pathExists(this._pagesPath))) {
			await this.json(path.join('.cache', 'pages'), {});
		}
	}

	static async init(mainPageUrl, options) {
		let loaderInstance = new Loader(mainPageUrl, options);
		await loaderInstance.prepareOutput();

		return loaderInstance;
	}
}

module.exports = Loader;