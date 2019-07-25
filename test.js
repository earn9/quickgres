const { Client } = require('.');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);
    const t0 = Date.now();
    const promises = [];
    for (var i = 0; i < 100000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    const results = await Promise.all(promises);
    console.error(1000 * results.reduce((s,r) => s+r.rows.length, 0) / (Date.now() - t0));
    console.error('\ndone');
    await client.end();
}

go();
