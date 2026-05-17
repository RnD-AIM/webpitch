module.exports = {
  apps: [{
    name: 'webpitch',
    script: 'server.js',
    node_args: '--env-file=/opt/webpitch/.env',
    cwd: '/opt/webpitch',
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
