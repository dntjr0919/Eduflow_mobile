/**
 * Vercel Serverless Function: /api/gas 호환 엔드포인트
 * Google Apps Script 프록시를 완전히 제거하고 Cloud Firestore 직접 핸들러(./firestore)로 위임합니다.
 */
module.exports = require('./firestore');
