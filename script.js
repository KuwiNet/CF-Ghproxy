function toSubmit(e) {
	e.preventDefault();
	const input = document.getElementsByName('q')[0];
	let userInput = input.value;

	// 去掉协议头
	userInput = userInput.replace(/^https?:\/\//, '');

	// 验证域名
	const validDomains = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com', 'api.github.com'];
	const isValidDomain = validDomains.some(domain => userInput.startsWith(domain));

	if (!isValidDomain) {
		showNotification('&#xe6aa;', '&nbsp;请输入 Github 链接');
		input.value = '';
		return;
	}

	const baseUrl = location.href.substr(0, location.href.lastIndexOf('/') + 1);
	const generatedUrl = baseUrl + userInput;

	// 显示生成的链接
	document.getElementById('generated-link').href = generatedUrl;
	document.getElementById('generated-link').textContent = generatedUrl;
	document.getElementById('result').style.display = 'block';

	// 清空输入框
	input.value = '';
}

function copyLink() {
	const link = document.getElementById('generated-link').href;
	navigator.clipboard.writeText(link).then(() => {
		showNotification('&#xe63f;', '&nbsp;链接已复制');
	}, (err) => {
		console.error('复制失败:', err);
	});
}

function jumpToLink() {
	const link = document.getElementById('generated-link').href;
	window.open(link, '_blank');
}

function showNotification(iconCode, message) {
	const notification = document.getElementById('notification');
	notification.innerHTML = `<span class="iconfont">${iconCode}</span> ${message}`;
	notification.classList.add('show');
	setTimeout(() => {
		notification.classList.remove('show');
	}, 3000);
}