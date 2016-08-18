module.exports = function(grunt) {
	grunt.initConfig({
		pkg: grunt.file.readJSON('package.json'),
				
		jshint: {
		    all: ['Gruntfile.js', 'src/js/*.js', '!src/js/d3.js']
		},

		compress: {
	  		main: {
			    options: {
			      archive: 'app.zip'
			    },
			    expand: true,
			    cwd: 'src',
			    src: ['**/*'],
			    dest: './'
		  	}
  		},
	});

	grunt.loadNpmTasks('grunt-contrib-compress');
	grunt.loadNpmTasks('grunt-contrib-jshint');

	grunt.registerTask('build', [
		'jshint',
		'compress'
	]);
	
};
