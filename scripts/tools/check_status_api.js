const http = require('http');

http.get('http://127.0.0.1:3000/api/status', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log(d);
  });
});
