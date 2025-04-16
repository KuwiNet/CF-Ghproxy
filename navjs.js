$('.navTrigger').click(function () {
    $(this).toggleClass('active');
    $("#mainListDiv").toggleClass("show_list");
    $("#mainListDiv").fadeIn();
});

$(window).scroll(function() {
    if ($(document).scrollTop() > 50) {
        $('.nav').addClass('affix');
    } else {
        $('.nav').removeClass('affix');
    }
});

$(window).resize(function() {
    if ($(window).width() <= 768) {
        $('.nav div.logo').css('padding-left', '1rem');
    } else {
        $('.nav div.logo').css('padding-left', '3rem');
    }
});