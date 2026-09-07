// 密码保护功能
// 当前部署：普通访客无需密码即可访问

function isPasswordProtected() {
    return false;
}

function isPasswordRequired() {
    return false;
}

function ensurePasswordProtection() {
    return true;
}

function verifyPassword(password) {
    return Promise.resolve(true);
}

function isPasswordVerified() {
    return true;
}

window.isPasswordProtected = isPasswordProtected;
window.isPasswordRequired = isPasswordRequired;
window.isPasswordVerified = isPasswordVerified;
window.verifyPassword = verifyPassword;
window.ensurePasswordProtection = ensurePasswordProtection;

function hidePasswordModal() {
    const passwordModal = document.getElementById("passwordModal");
    if (passwordModal) {
        passwordModal.style.display = "none";
    }
}

function showPasswordModal() {
    hidePasswordModal();
}

function showPasswordError() {}

function hidePasswordError() {}

function handlePasswordSubmit() {}

function initPasswordProtection() {
    // 当前关闭普通访客密码验证
    hidePasswordModal();
}

document.addEventListener("DOMContentLoaded", function () {
    initPasswordProtection();
});
