module.exports = {
  apps: [{
    name: 'webpitch',
    script: 'node',
    args: '--env-file=/opt/webpitch/.env server.js',
    cwd: '/opt/webpitch',
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
