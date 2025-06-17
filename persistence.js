
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, './hedgeBoundary.json');

function loadBoundary() {
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {
      trailingBoundary: null,
      boundaries: { top: null, bottom: null }
    };
  }
}

function saveBoundary({ trailingBoundary, boundaries }) {
  const data = {
    trailingBoundary,
    boundaries
  };
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

function clearBoundary() {
  const data = {
    trailingBoundary: null,
    boundaries: { top: null, bottom: null }
  };
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
  loadBoundary,
  saveBoundary,
  clearBoundary
};
