export default {
	"*.{js,jsx,ts,tsx}": ["prettier --write", "biome check --fix"],
	"*.json": ["prettier --write"]
};
