const isArray = function (obj) {
	return obj.catalog.constructor.name == "Array";
}
const queryObject = function (obj, p) { 
	let t = isArray(p) ? p : p.split('.'); 
	if (t.length == 1) return obj[t[0]]; 
	if (t[0].slice(-2) == "[]") { 
		return obj[t[0].slice(0,-2)].map(i => queryObject(i, t.slice(1))); 
	} else { 
		return queryObject(obj[t[0]], t.slice(1)); 
	} 
};

module.exports = {
	isArray,
	queryObject
};