var pwdReg = /^(?=.*[A-Za-z])(?=.*\d).{6,30}$/;
var apPwdReg = /^(?=.*[A-Za-z])(?=.*\d).{8,30}$/;
var ssidReg = /^[A-Za-z0-9!@#$%^&*()_\-+=\[\]{};:'",<.>\/?\\|`~]+$/;
var ipv4Reg = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
/** 填充元素HTML
 * className    元素类名
 * content    html内容
 * **/
function innerHtml(className, content) {
  var dom = querySelector(className);
  if (dom) {
    dom.innerHTML = content;
  }
}

function querySelector(str) {
  return document.querySelector(str);
}
function querySelectorAll(str) {
  return document.querySelectorAll(str);
}

var langMap = {
  EN: 'English',
  DE: 'Deutsch',
  ZH: '简体中文',
  JA: '日本語'
};
// 获取语种，默认英语
function getlang() {
  const lang = (navigator.language || navigator.userLanguage).toUpperCase();
  const shortLang = lang.split('-')[0];
  const localLan = localStorage.getItem('pcs_local_web_lang');
  if (localLan) {
    return localLan;
  }
  if (langMap[shortLang]) {
    return shortLang;
  }
  return 'EN';
}
function getlangText() {
  return langMap[getlang()];
}
function setLang(lan) {
  localStorage.setItem('pcs_local_web_lang', lan);
}

// 获取国际化词条
function getLocal() {
  var lan = getlang();
  switch (lan) {
    case 'ZH':
      return local_cn;
    case 'EN':
      return local_en;
    case 'DE':
      return local_de;
    case 'JA':
      return local_ja;
    default:
      return local_en;
  }
}

/** 初始化页面文案
 * */
function initPageText() {
  var local = getLocal();
  var doms = querySelectorAll('[lanT]');
  doms.forEach(i => {
    var textName = i.getAttribute('lanT');
    i.innerHTML = local[textName] || '';
  });
}

// 兼容移动端光标没有在输入框末尾
function androidInputFocusListener() {
  document.querySelectorAll('input:not([type="radio"]):not([type="checkbox"])').forEach(item => {
    item.addEventListener('focus', function () {
      var input = this;
      setTimeout(function () {
        input.selectionStart = input.selectionEnd = input.value.length;
      }, 30);
    });
  });
}

/**
 * 发送 CGI 请求，并在 AES 密钥缺失或不同步时自动恢复一次密钥交换。
 * @param {Object} params 请求配置。
 * @returns {void}
 * */
function request(params) {
  const {
    methods = 'get',
    url,
    async = true,
    successCb,
    failedCb,
    data,
    timeout = 0,
    retryCount = 100,
    headers,
    keyReadyRetryCount = 1,
    decryptRetryCount = 1,
    keyResyncRetryCount = 1
  } = params;
  if (!navigator.onLine) {
    if (retryCount > 0) {
      setTimeout(() => {
        request({...params, retryCount: retryCount - 1});
      }, 100);
    } else {
      alert(getLocal()['c6']);
    }
    return;
  }

  if (needEncrypt && shouldEncryptUrl(url) && !sessionStorage.getItem('PCS_LOCAL_WEB')) {
    if (keyReadyRetryCount > 0) {
      getPublicKey(
        function () {
          request({...params, keyReadyRetryCount: keyReadyRetryCount - 1});
        },
        failedCb
      );
    } else {
      failedCb && failedCb();
    }
    return;
  }

  var XHR = new XMLHttpRequest();
  var encryptUrl = encryptMessage(url);
  console.log('request url=>', url);
  XHR.open(methods, encryptUrl, async);
  XHR.timeout = timeout;

  if (headers) {
    Object.keys(headers).forEach(key => {
      XHR.setRequestHeader(key, headers[key]);
    });
  }

  XHR.send(data);
  XHR.onreadystatechange = function () {
    try {
      if (XHR.readyState == 4) {
        if (XHR.status === 200) {
          // console.log('request success====>', XHR.responseText);
          let decryptMsg = decryptMessage(XHR.responseText, url);
          if (decryptMsg === null) {
            if (decryptRetryCount > 0) {
              sessionStorage.removeItem('PCS_LOCAL_WEB');
              getPublicKey(
                function () {
                  request({...params, decryptRetryCount: decryptRetryCount - 1});
                },
                failedCb
              );
            } else {
              failedCb && failedCb();
            }
            return;
          }
          console.log('decryptMsg====>', decryptMsg);
          if (handleResText(decryptMsg).token_timeout) {
            window.top.location.replace('/');
          } else {
            successCb && successCb(decryptMsg);
          }
        } else if (XHR.status !== 0) {
          // status 0 为传输层错误（空响应/中断），交给 onerror/ontimeout 处理（含密钥不同步自恢复），不在此误报失败
          failedCb && failedCb();
        }
      }
    } catch (error) {
      console.error('error', error);
    }
  };
  // onerror（空响应/中断）与 ontimeout（连接超时）都属于传输层失败，走同一恢复逻辑。
  function handleTransportError() {
    // 设备持有的 AES 密钥可能与浏览器不一致：设备无法解密本次请求 → 返回空响应触发 onerror（ERR_EMPTY_RESPONSE）。
    // 加密接口先尝试一次重新换密钥并重发（require/send 是未加密的引导接口，不受密钥不同步影响），
    // 失败再退回普通网络重试，避免一直拿着过期密钥无限重发。
    if (needEncrypt && shouldEncryptUrl(url) && sessionStorage.getItem('PCS_LOCAL_WEB') && keyResyncRetryCount > 0) {
      sessionStorage.removeItem('PCS_LOCAL_WEB');
      getPublicKey(
        function () {
          // 换到新密钥，重发一次本请求
          request({...params, keyResyncRetryCount: keyResyncRetryCount - 1});
        },
        function () {
          // 重换密钥已用尽内部重试仍失败（设备不可达）：立即提示，不再拿过期密钥空转
          failedCb && failedCb();
        }
      );
      return;
    }
    if (retryCount > 0) {
      setTimeout(() => {
        request({...params, retryCount: retryCount - 1});
      }, 500);
    } else {
      failedCb && failedCb();
    }
  }
  // 超时按传输层失败处理：设备不可达时按 timeout 快速浮出，不再空等 OS 连接超时（几十秒）。
  XHR.ontimeout = function () {
    console.log('ontimeout', url);
    handleTransportError();
  };
  XHR.onerror = function (err) {
    console.log('onerror', err);
    handleTransportError();
  };
}

// 密码框内容的显示|关闭
function showPassword(inputClass, eyeClass) {
  var ipt = querySelector(inputClass);
  var eye = querySelector(eyeClass);

  if (ipt.type == 'password') {
    ipt.type = 'text';
    eye.src = '../imgs/eye.svg';
  } else {
    ipt.type = 'password';
    eye.src = '../imgs/closeEye.svg';
  }
}
function togglePasswordEye(v, eyeClass) {
  if (v.length) {
    show(eyeClass);
  } else {
    hide(eyeClass);
  }
}

// 显示dom
function show(v) {
  var c = querySelector(v);
  if (c != null) {
    c.style.display = 'block';
  }
}

// 隐藏dom
function hide(v) {
  var c = querySelector(v);
  if (c != null) {
    c.style.display = 'none';
  }
}

/** 信号强度
 * strength 0-5 共6个等级，5级满格
 * 如果想传入其他值，需要将其转为0-5这几个等级
 * */
function signal(strength) {
  strength = parseInt(strength);
  // 高度
  var barsHeight = [18, 30, 45, 57, 72];
  var bgColor = '#F5F5F5';
  var fillColor = bgColor;
  switch (strength) {
    case 1:
    case 2:
      fillColor = '#E50113';
      break;
    case 3:
    case 4:
      fillColor = '#FFC225';
      break;
    case 5:
      fillColor = '#3BCE76';
      break;
  }
  var bars = barsHeight.map((v, i) => {
    return (
      '<div class="inBlock" style="width: 10px; height: ' +
      v +
      'px; background-color:' +
      (i < strength ? fillColor : bgColor) +
      '; margin-left: 6px;"></div>'
    );
  });

  return (
    '<div style="width: 24px; height: 24px; overflow: hidden; padding-top: 3px"><div style="width: 96px; height: 96px; text-align: center; transform: scale(0.25); transform-origin: top left">' +
    bars.join('') +
    '</div></div>'
  );
}

// 获取query字段
function getQueryString(name, url = window.location.href) {
  var reg = new RegExp('[?&]' + name + '=([^&#]*)', 'i');
  var res = url.match(reg);

  if (res && res.length > 1) {
    return decodeURIComponent(res[1]);
  }
  return '';
}

// 返回数据中如果有JSON，需要这样处理
function handleResText(t) {
  var json_start = t.indexOf('json_start');
  var json_end = t.indexOf('json_end');

  if (json_start === -1 || json_end === -1) {
    return t;
  }

  var json_start_index = json_start + 'json_start'.length;
  var json_content = t.substring(json_start_index, json_end);
  try {
    return JSON.parse(json_content);
  } catch (error) {
    console.error('Failed to parse JSON content: ' + error.message);
    return json_content;
  }
}

function initLanSelect() {
  var list = Object.keys(langMap).map(v => `<div class="lanItem lan_${v}" onclick="changeLan('${v}')">${langMap[v]}</div>`);
  innerHtml('.lanSelect', list.join(''));
  var lanST = querySelector('.lanST');
  lanST.addEventListener('mouseover', function () {
    show('.lanSelect');
  });
  lanST.addEventListener('mouseleave', function () {
    hide('.lanSelect');
  });
}

/******RSA加密*********/
const rsa = new JSEncrypt();
// 加密
function encrypt_rsa(publicKey, v) {
  if (publicKey) {
    rsa.setPublicKey(publicKey);
    return rsa.encrypt(v);
  }
  return v;
}

// 解密
// function decrypt(v) {
//   if (publicKey) {
//     rsa.setPrivateKey(publicKey);
//     return rsa.decrypt(v);
//   }
//   return v;
// }

/**********AES加密************/
const needEncrypt = true;

function zeroPad(data, blockSize) {
  var padLength = blockSize - (data.sigBytes % blockSize);
  var paddingWordArray = CryptoJS.lib.WordArray.create([], padLength);
  return data.concat(paddingWordArray);
}
var blockSize = 16; // 块大小（字节）
var whiteList = ['require', 'send'];

/**
 * 获取 CGI 名称前缀，用于判断是否需要 AES 加密。
 * @param {string} url 请求地址。
 * @returns {string} CGI 名称前缀。
 */
function getUrlPrefix(url) {
  return (url || '').split('.')[0];
}

/**
 * 判断请求地址是否需要 AES 加密。
 * @param {string} url 请求地址。
 * @returns {boolean} 是否需要 AES 加密。
 */
function shouldEncryptUrl(url) {
  return !whiteList.includes(getUrlPrefix(url));
}

/**
 * 移除 NoPadding 解密后尾部的零填充。
 */
function trimZeroPadding(value) {
  return typeof value === 'string' ? value.replace(/\x00+$/g, '') : value;
}

/**
 * 判断响应是否带有设备端加密响应结束标记。
 * @param {string} value 响应内容。
 * @returns {boolean} 是否看起来像设备端 AES 响应。
 */
function looksEncryptedResponse(value) {
  return typeof value === 'string' && value.indexOf('result_end') !== -1;
}

// 加密
/**
 * 按设备约定加密 CGI URL。
 * @param {string} v 原始 URL。
 * @returns {string} 加密或 base64 后的 URL。
 */
function encryptMessage(v) {
  if (!needEncrypt) {
    return v;
  }
  const publicKey = sessionStorage.getItem('PCS_LOCAL_WEB');
  if (publicKey && shouldEncryptUrl(v)) {
    function encrypt() {
      var key = CryptoJS.enc.Utf8.parse(publicKey);
      var data = zeroPad(CryptoJS.enc.Utf8.parse(v), blockSize);
      let result = CryptoJS.AES.encrypt(data, key, {
        iv: key,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.NoPadding
      });
      return CryptoJS.enc.Base64.stringify(result.ciphertext);
    }
    let encryptUrl = encrypt();
    // while (encryptUrl.startsWith('/')) {
    //   encryptUrl = encrypt();
    // }
    return encryptUrl;
  }
  return btoa(v);
}

// 解密
/**
 * 解密设备响应，并用 null 标记密钥不同步。
 * @param {string} v 响应内容。
 * @param {string} url 请求地址。
 * @returns {string|null} 解密后的响应，或密钥不同步标记。
 */
function decryptMessage(v, url) {
  if (!needEncrypt) {
    return v;
  }
  const publicKey = sessionStorage.getItem('PCS_LOCAL_WEB');
  var rawResponse = v;
  // console.log('publicKey', publicKey);
  if (publicKey && shouldEncryptUrl(url)) {
    var key = CryptoJS.enc.Utf8.parse(publicKey);
    let index = v.lastIndexOf('result_end');
    v = index === -1 ? v : v.slice(0, index);
    try {
      var decryptText = CryptoJS.AES.decrypt(v, key, {
        iv: key,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.NoPadding
      }).toString(CryptoJS.enc.Utf8);
      decryptText = trimZeroPadding(decryptText);
      if (!decryptText && looksEncryptedResponse(rawResponse)) {
        return null;
      }
      return decryptText;
    } catch (error) {
      console.error('decrypt failed', error);
      return null;
    }
  }
  if (shouldEncryptUrl(url) && looksEncryptedResponse(rawResponse)) {
    return null;
  }
  return v;
}

// 中文校验
function containsChinese(str) {
  const regex = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  return regex.test(str);
}

var _gettingPublicKey = false;
var _publicKeyCallbacks = [];
// 密钥交换（require/send）的网络重试上限：约 3×500ms≈1.5s 后失败浮出，供 onerror 恢复快速判定设备是否可达
var KEY_EXCHANGE_RETRY = 3;
// 单个 CGI 请求的超时时间（毫秒）。设备不可达时按此快速浮出失败，避免空等 OS 连接超时（几十秒）。
// 仅用于登录与密钥交换（login/require/send）；OTA 上传、烧录状态轮询等长耗时请求保持默认 0（不超时），以免误杀固件升级。
var CGI_REQUEST_TIMEOUT = 3000;

/**
 * 执行所有等待密钥交换成功的回调。
 */
function runPublicKeySuccessCallbacks() {
  var callbacks = _publicKeyCallbacks.slice();
  _publicKeyCallbacks = [];
  callbacks.forEach(function (callbackItem) {
    callbackItem.successCb && callbackItem.successCb();
  });
}

/**
 * 执行所有等待密钥交换失败的回调。
 */
function runPublicKeyFailedCallbacks() {
  var callbacks = _publicKeyCallbacks.slice();
  _publicKeyCallbacks = [];
  callbacks.forEach(function (callbackItem) {
    callbackItem.failedCb && callbackItem.failedCb();
  });
}

function resetPublicKeyState() {
  _gettingPublicKey = false;
  // 只清 AES 密钥；
  sessionStorage.removeItem('PCS_LOCAL_WEB');
}

/**
 * 获取 RSA 公钥并发送新的 AES key，支持并发请求排队。
 * @param {Function} callback 密钥交换成功回调。
 * @param {Function} failedCallback 密钥交换失败回调。
 */
function getPublicKey(callback, failedCallback) {
  if (callback || failedCallback) {
    _publicKeyCallbacks.push({
      successCb: callback,
      failedCb: failedCallback
    });
  }
  if (_gettingPublicKey) {
    return;
  }
  _gettingPublicKey = true;
  request({
    url: 'require.cgi?t=' + Math.random(),
    retryCount: KEY_EXCHANGE_RETRY,
    timeout: CGI_REQUEST_TIMEOUT,
    successCb: function (responseText) {
      var r = handleResText(responseText);
      console.log('[ PCS_LOCAL_WEB_RSA_PUBLIC_KEY ] >', r);
      if (typeof r === 'string' && r.indexOf('BEGIN PUBLIC KEY') !== -1) {
        sessionStorage.setItem('PCS_LOCAL_WEB_RSA_PUBLIC_KEY', r);
        sendKey(r);
      } else {
        // token 已过期，清除旧会话数据，等待用户重新登录
        console.error('Invalid RSA public key received:', r);
        // 仅在确认公钥失效时单独清除 RSA 公钥
        sessionStorage.removeItem('PCS_LOCAL_WEB_RSA_PUBLIC_KEY');
        resetPublicKeyState();
        runPublicKeyFailedCallbacks();
      }
    },
    failedCb: function () {
      resetPublicKeyState();
      runPublicKeyFailedCallbacks();
    }
  });
}

/**
 * 使用 RSA 公钥发送新的 AES key。
 * @param {string} key RSA 公钥。
 */
function sendKey(key) {
  if (key) {
    let randomNum = Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
    request({
      url: 'send.cgi?key=' + encrypt_rsa(key, randomNum) + '&t=' + Math.random(),
      retryCount: KEY_EXCHANGE_RETRY,
      timeout: CGI_REQUEST_TIMEOUT,
      successCb: function (r) {
        _gettingPublicKey = false;
        if (r.indexOf('success') != -1) {
          sessionStorage.setItem('PCS_LOCAL_WEB', randomNum);
          runPublicKeySuccessCallbacks();
        } else {
          resetPublicKeyState();
          runPublicKeyFailedCallbacks();
        }
      },
      failedCb: function () {
        resetPublicKeyState();
        runPublicKeyFailedCallbacks();
      }
    });
  } else {
    resetPublicKeyState();
    runPublicKeyFailedCallbacks();
  }
}

// 计算输入字符串的字节长度
function getByteLength(str) {
  let byteLength = 0;
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode <= 0x007f) {
      byteLength += 1; // 英文字母或数字占 1 个字节
    } else {
      byteLength += 2; // 中文字符及其他字符占 2 个字节
    }
  }
  return byteLength;
}

// 用户名、ssid、密码 设置时校验规则
function commonValidate({value, reValue, isPassword}) {
  const result = {
    valid: false,
    message: ''
  };

  // 长度校验
  if (value.length < 8 || value.length > 16) {
    result.message = getLocal()['c7'];
    return result;
  }

  // 中文字符校验（匹配中文）
  if (/[\u4e00-\u9fa5]/.test(value)) {
    result.message = getLocal()['c8'];
    return result;
  }

  // 空格校验
  if (/\s/.test(value)) {
    result.message = getLocal()['c9'];
    return result;
  }

  // 只允许字母、数字、指定标点
  const allowedCharsRegex = /^[A-Za-z0-9~!@#$%^&*()_+`\-={}|[\]\\:";'<>?,./]+$/;
  if (!allowedCharsRegex.test(value)) {
    result.message = getLocal()['c10'];
    return result;
  }

  // isPassword 时开启
  if (isPassword) {
    if (!value) {
      result.message = getLocal()['a13'];
      return result;
    }
    if (!reValue) {
      result.message = getLocal()['a14'];
      return result;
    }
    // 密码不一致
    if (value !== reValue) {
      result.message = getLocal()['c12'];
      return result;
    }
    // 至少包含两种类型
    const hasLetter = /[A-Za-z]/.test(value);
    const hasNumber = /[0-9]/.test(value);
    const hasSymbol = /[~!@#$%^&*()_+`\-={}|[\]\\:";'<>?,./]/.test(value);

    const typeCount = [hasLetter, hasNumber, hasSymbol].filter(Boolean).length;
    if (typeCount < 2) {
      result.message = getLocal()['c11'];
      return result;
    }
  }

  // 全部通过
  result.valid = true;
  return result;
}

// 1. 必须是 x.x.x.x，每段 1~3 位数字
// 2. 每段范围 0~255，不能有前导零（除 0 本身）
function isValidIPv4(ip) {
  return ipv4Reg.test(ip);
}
